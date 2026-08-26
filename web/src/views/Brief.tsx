import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import type { Brief, Evidence } from "../lib/api";
import { useStore } from "../lib/store";
import { StatusDot, HEALTH_LABEL } from "../lib/ui";
import { DecisionCard } from "./DecisionCard";
import { EvidenceStrip, ReviewAudit, ReviewCard, ReviewUnderstanding } from "./ReviewCard";
import { AttentionRows, BlockedByLine } from "./attention";
import { CheckpointsInbox } from "./Checkpoints";
import { UnderstandingQuiz } from "./UnderstandingQuiz";
import { fmtUsd, fmtTokens } from "./Analytics";
import { itemProject } from "../lib/needsYou";
import type { NeedsYouItem } from "../lib/needsYou";
import { useProjectFilter, setProjectFilter, inProjectFilter } from "../lib/projectFilter";
import { taskLabel } from "../lib/references";

const LAST_SEEN_KEY = "hive.brief.lastSeen";
const MODE_KEY = "hive.inbox.mode";
const ITEM_LABELS: Record<NeedsYouItem["kind"], string> = {
  decision: "Decision",
  checkpoint: "Checkpoint",
  quiz_digest: "Catch up",
  review: "Review",
  attention: "Issue",
  waiting: "Waiting",
};

// A calm memo section: a heading with a count, then its body. Renders nothing
// when empty so the brief collapses to only what needs the reader.
function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="brief-section">
      <h2 className="brief-h">
        {title} <span className="brief-count">{count}</span>
      </h2>
      {children}
    </section>
  );
}

// <input type="datetime-local"> wants a local "YYYY-MM-DDTHH:mm" string, not ISO.
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TaskEvidence({ taskId, title, compact = false }: { taskId: string; title: string; compact?: boolean }) {
  const { rev, tasks } = useStore();
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const task = tasks.find((item) => item.id === taskId);
  useEffect(() => {
    let live = true;
    api.evidence({ task: taskId, limit: 100 }).then((result) => live && setEvidence(result.evidence)).catch(() => live && setEvidence([]));
    return () => { live = false; };
  }, [taskId, rev[taskId]]);
  return <EvidenceStrip evidence={evidence} task={{ id: taskId, title, head_sha: task?.head_sha ?? null }} limit={compact ? 4 : undefined} />;
}

export default function Brief() {
  const { needsYou: allNeedsYou, reloadQuizzes, tasks, projects } = useStore();
  const location = useLocation();
  // Same project filter the board and the other inboxes use, so picking a
  // project anywhere scopes this queue too.
  const projectFilter = useProjectFilter();
  const needsYou = useMemo(
    () => allNeedsYou.filter((item) => inProjectFilter(itemProject(item, tasks), projectFilter)),
    [allNeedsYou, tasks, projectFilter],
  );
  const [mode, setMode] = useState<"focus" | "backlogs">(() => localStorage.getItem(MODE_KEY) === "backlogs" ? "backlogs" : "focus");

  // Default the activity-summary window to the last time Needs you was viewed
  // (localStorage, same pattern as the feed's last-seen). Read the stored marker
  // now, then stamp this visit so next time the window starts where this one opened.
  const marker = useMemo(() => localStorage.getItem(LAST_SEEN_KEY), []);
  useEffect(() => {
    localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
  }, []);

  const [since, setSince] = useState<string | undefined>(marker || undefined);
  const [data, setData] = useState<Brief | null>(null);

  useEffect(() => {
    let live = true;
    api.morningBrief(since, projectFilter).then((b) => live && setData(b)).catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [since, projectFilter]);

  // Action sections read from the live store so handling an item updates in
  // place via SSE. The disclosed activity summary reads the fetched snapshot.
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [passedQuizzes, setPassedQuizzes] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  useEffect(() => {
    const active = new Set(needsYou.flatMap((item) => item.kind === "review" ? [item.id] : []));
    setReviewed((items) => {
      const next = new Set([...items].filter((id) => active.has(id)));
      return next.size === items.size ? items : next;
    });
  }, [needsYou]);
  const openDecisions = needsYou.flatMap((item) => item.kind === "decision" && !answered.has(item.id) ? [item.decision] : []);
  const checkpoints = needsYou.flatMap((item) => item.kind === "checkpoint" ? [item.checkpoint] : []);
  // One digest per project, holding only the changes still to catch up on.
  // Answering one drops it out here, so the digest empties as you work through it.
  const remainingIn = (item: NeedsYouItem) =>
    item.kind === "quiz_digest" ? item.quizzes.filter((quiz) => !passedQuizzes.has(quiz.id)) : [];
  const digests = needsYou.flatMap((item) => {
    const remaining = remainingIn(item);
    return remaining.length ? [{ id: item.id, total: item.kind === "quiz_digest" ? item.quizzes.length : 0, remaining }] : [];
  });
  const toReview = needsYou.flatMap((item) => item.kind === "review" && !reviewed.has(item.id) ? [item.task] : []);
  const attention = needsYou.flatMap((item) => item.kind === "attention" ? [item.task] : []);
  const waiting = needsYou.flatMap((item) => item.kind === "waiting" ? [{ task: item.task, blockedBy: item.blockedBy }] : []);

  // The activity summary is a fetched snapshot, so scope its rows here too.
  function scope<T extends { project_id: string }>(rows: T[]): T[] {
    return rows.filter((row) => inProjectFilter(row.project_id, projectFilter));
  }
  const done = scope(data?.done ?? []);
  const fleet = scope(data?.fleet ?? []);
  const incidents = scope(data?.incidents ?? []);
  const intake = scope(data?.intake ?? []);
  const learnings = scope(data?.learnings_new ?? []);
  const spend = data?.spend;
  const spendCount = spend ? spend.totals.calls : 0;

  // A digest counts as ONE item however many changes it holds.
  const actionCount = openDecisions.length + checkpoints.length + digests.length + toReview.length + attention.length;
  // The focus queue, in order. Handled items drop out, so the index naturally
  // lands on the next one; the arrows let you step past anything you can't act on.
  const focusItems = useMemo(() => {
    const seenCheckpointTasks = new Set<string>();
    return needsYou.filter((item) => {
      if (item.kind === "decision") return !answered.has(item.id);
      if (item.kind === "quiz_digest") return remainingIn(item).length > 0;
      if (item.kind === "review") return !reviewed.has(item.id);
      if (item.kind === "waiting") return false;
      // One card per task: CheckpointsInbox already shows the task's checkpoints together.
      if (item.kind === "checkpoint") {
        if (seenCheckpointTasks.has(item.checkpoint.task_id)) return false;
        seenCheckpointTasks.add(item.checkpoint.task_id);
      }
      return true;
    });
  }, [needsYou, answered, passedQuizzes, reviewed]);
  const focusCount = focusItems.length;
  const [focusIdx, setFocusIdx] = useState(0);
  const at = Math.min(focusIdx, Math.max(0, focusCount - 1));
  const focusItem = focusItems[at];
  const chooseMode = (next: "focus" | "backlogs") => {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  };
  const activeProject = projects.find((p) => p.id === projectFilter);
  const taskIdLabel = (id: string, number: number) => taskLabel(tasks.find((task) => task.id === id) ?? { number });

  return (
    <div className="brief-page">
      <header className="brief-top">
        <div>
          <h1 className="brief-title">{mode === "focus" ? "Focus" : "Backlogs"}</h1>
          <div className="brief-since muted">
            {mode === "focus" ? "One thing at a time. Hive picks what needs you next." : "Every queue, grouped so you can scan what remains."}
          </div>
        </div>
        <div className="brief-mode-switch" role="group" aria-label="Needs you view">
          <button aria-pressed={mode === "focus"} onClick={() => chooseMode("focus")}>Focus</button>
          <button aria-pressed={mode === "backlogs"} onClick={() => chooseMode("backlogs")}>Backlogs <span>{actionCount}</span></button>
        </div>
      </header>

      <div className="board-switch brief-projects" role="group" aria-label="Project filter">
        <span className="board-switch-label">Project</span>
        <button aria-pressed={!projectFilter} className={`board-chip ${projectFilter ? "" : "board-chip-on"}`} onClick={() => setProjectFilter("")}>All</button>
        {projects.map((p) => (
          <button
            key={p.id}
            aria-pressed={projectFilter === p.id}
            className={`board-chip ${projectFilter === p.id ? "board-chip-on" : ""}`}
            onClick={() => setProjectFilter(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>

      {data && actionCount === 0 && (
        <div className="brief-quiet">
          <div className="empty-big">All quiet.</div>
          <div className="muted">
            {`Nothing needs you${activeProject ? ` in ${activeProject.name}` : ""}.`}
            {waiting.length > 0 && ` ${waiting.length} waiting on a merge.`}
          </div>
        </div>
      )}

      {/* A new item must not inherit the previous card's submit state or evidence. */}
      {mode === "focus" && focusItem && (
        <section className="brief-focus" key={`${focusItem.kind}:${focusItem.id}`}>
          <div className="brief-focus-meta">
            <span>{ITEM_LABELS[focusItem.kind]}</span>
            <span className="brief-focus-nav">
              <button className="btn btn-mini" aria-label="Previous item" disabled={at === 0} onClick={() => setFocusIdx(at - 1)}>&larr;</button>
              {at + 1} of {focusCount}
              <button className="btn btn-mini" aria-label="Next item" disabled={at >= focusCount - 1} onClick={() => setFocusIdx(at + 1)}>&rarr;</button>
            </span>
          </div>
          {focusItem.kind === "decision" && (
            <DecisionCard d={focusItem.decision} onDone={(id) => setAnswered((items) => new Set(items).add(id))} />
          )}
          {focusItem.kind === "checkpoint" && <CheckpointsInbox taskId={focusItem.checkpoint.task_id} heading={false} />}
          {focusItem.kind === "quiz_digest" && (() => {
            // One change at a time, in order. Passing the current one drops it
            // from `remaining`, so the next change slides in without a click.
            const remaining = remainingIn(focusItem);
            const quiz = remaining[0];
            const at = focusItem.quizzes.length - remaining.length + 1;
            return (
              <div className="brief-quiz">
                <div className="brief-digest-head">
                  <strong>Catch up on {focusItem.quizzes.length} shipped {focusItem.quizzes.length === 1 ? "change" : "changes"}</strong>
                  <span className="muted">Change {at} of {focusItem.quizzes.length}</span>
                </div>
                <Link to={`/tasks/${quiz.task_id}`}>{taskIdLabel(quiz.task_id, quiz.task_number)} {quiz.task_title}</Link>
                <details className="review-details" open>
                  <summary>
                    <span>{quiz.task_kind === "scout" ? "Explain report" : "Understand this change"}</span>
                    <small>Read before answering</small>
                  </summary>
                  <div className="review-details-body">
                    {quiz.report.understanding && (
                      <ReviewUnderstanding packet={quiz.report.understanding} report={quiz.task_kind === "scout"} caveats={quiz.report.iffy} />
                    )}
                    <ReviewAudit r={quiz.report} />
                  </div>
                </details>
                <UnderstandingQuiz
                  quiz={quiz}
                  // These already shipped, so the default "Before you approve" would lie.
                  label="Catch up on this change"
                  surface="focus"
                  onPassed={() => {
                    setPassedQuizzes((items) => new Set(items).add(quiz.id));
                    reloadQuizzes();
                  }}
                />
              </div>
            );
          })()}
          {focusItem.kind === "review" && (
            <ReviewCard task={focusItem.task} surface="focus" onDone={() => setReviewed((items) => new Set(items).add(focusItem.id))} />
          )}
          {focusItem.kind === "attention" && <div className="brief-attn"><AttentionRows tasks={[focusItem.task]} /></div>}
          {focusItem.kind !== "review" && (
            <TaskEvidence
              taskId={focusItem.kind === "decision" ? focusItem.decision.task_id : focusItem.kind === "checkpoint" ? focusItem.checkpoint.task_id : focusItem.kind === "quiz_digest" ? remainingIn(focusItem)[0].task_id : focusItem.task.id}
              title={focusItem.kind === "decision" ? focusItem.decision.title : focusItem.kind === "checkpoint" ? focusItem.checkpoint.task_title : focusItem.kind === "quiz_digest" ? remainingIn(focusItem)[0].task_title : focusItem.task.title}
            />
          )}
          {focusCount > 1 && <div className="brief-queue-note">{focusCount - 1} more waiting.</div>}
        </section>
      )}

      {mode === "backlogs" && (
        <div className="brief-backlogs">
          <Section title="Decisions" count={openDecisions.length}>
            <ul className="brief-backlog-list">
              {openDecisions.map((decision) => <li key={decision.id}><Link to={`/decisions#dcard-${decision.id}`}>{decision.title}</Link><span>{decision.risk || "decision"}</span><TaskEvidence taskId={decision.task_id} title={decision.title} compact /></li>)}
            </ul>
          </Section>
          <Section title="Checkpoints" count={checkpoints.length}>
            <ul className="brief-backlog-list">
              {checkpoints.map((checkpoint) => <li key={checkpoint.id}><Link to={`/tasks/${checkpoint.task_id}`} state={{ backgroundLocation: location }}>{taskIdLabel(checkpoint.task_id, checkpoint.task_number)} {checkpoint.task_title}</Link><span>{checkpoint.note}</span><TaskEvidence taskId={checkpoint.task_id} title={checkpoint.task_title} compact /></li>)}
            </ul>
          </Section>
          {/* One row for the whole catch-up, not one per shipped change. It opens
              the single sequential flow in Focus. */}
          <Section title="Catch up" count={digests.length}>
            <ul className="brief-backlog-list">
              {digests.map((digest) => (
                <li key={digest.id}>
                  <button className="link-btn" onClick={() => { setFocusIdx(focusItems.findIndex((item) => item.id === digest.id)); chooseMode("focus"); }}>
                    Catch up on {digest.total} shipped {digest.total === 1 ? "change" : "changes"}
                  </button>
                  <span>{digest.remaining.length} left</span>
                  <TaskEvidence taskId={digest.remaining[0].task_id} title={digest.remaining[0].task_title} compact />
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Reviews" count={toReview.length}>
            <ul className="brief-backlog-list">
              {toReview.map((task) => <li key={task.id}><Link to={`/tasks/${task.id}`} state={{ backgroundLocation: location }}>{taskLabel(task)} {task.title}</Link><span>{task.ci_status === "passing" ? "Ready" : task.ci_status || "Review"}</span><TaskEvidence taskId={task.id} title={task.title} compact /></li>)}
            </ul>
          </Section>
          <Section title="Issues" count={attention.length}>
            <ul className="brief-backlog-list">
              {attention.map((task) => <li key={task.id}><Link to={`/tasks/${task.id}`} state={{ backgroundLocation: location }}>{taskLabel(task)} {task.title}</Link><span>{task.health?.reason || task.summary || "Needs attention"}</span><TaskEvidence taskId={task.id} title={task.title} compact /></li>)}
            </ul>
          </Section>
          <Section title="Waiting" count={waiting.length}>
            <ul className="brief-backlog-list">
              {waiting.map(({ task, blockedBy }) => (
                <li key={task.id}>
                  <Link to={`/tasks/${task.id}`} state={{ backgroundLocation: location }}>{taskLabel(task)} {task.title}</Link>
                  <span><BlockedByLine blockedBy={blockedBy} /></span>
                  <TaskEvidence taskId={task.id} title={task.title} compact />
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}

      {mode === "backlogs" && data && (
        <details className="brief-digest">
          <summary>
            <span>Activity summary</span>
            <small>Done, fleet, incidents, and more</small>
          </summary>
          <div className="brief-digest-body">
            <label className="brief-picker">
              <span className="muted">Since</span>
              <input
                type="datetime-local"
                value={since ? toLocalInput(since) : ""}
                max={toLocalInput(new Date().toISOString())}
                onChange={(e) => setSince(e.target.value ? new Date(e.target.value).toISOString() : undefined)}
              />
            </label>

            <Section title="Done" count={done.length}>
              <ul className="brief-list">
                {done.map((t) => (
                  <li key={t.id} className="brief-done-row">
                    <Link className="brief-done-title" to={`/tasks/${t.id}`} state={{ backgroundLocation: location }}>{t.title}</Link>
                    <span className="chip">{t.project_name}</span>
                    {t.summary && <span className="brief-done-summary muted">{t.summary}</span>}
                    <Link className="brief-evc" to={`/tasks/${t.id}`} state={{ backgroundLocation: location }} title="Evidence">◱ {t.evidence_count}</Link>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Fleet now" count={fleet.length}>
              <ul className="brief-list">
                {fleet.map((t) => (
                  <li key={t.id} className="brief-fleet-row">
                    <StatusDot state={t.state} health={t.health} />
                    <Link className="brief-fleet-title" to={`/tasks/${t.id}`} state={{ backgroundLocation: location }}>{t.title}</Link>
                    <span className={`brief-health attn-${t.health?.status ?? "healthy"}`}>{t.health ? t.health.reason || HEALTH_LABEL[t.health.status] : "working"}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Incidents" count={incidents.length}>
              <ul className="brief-list">
                {incidents.map((i) => (
                  <li key={i.id} className={`brief-incident inc-${i.status}`}>
                    <span className={`brief-inc-status inc-${i.status}`}>{i.status}</span>
                    <span className="brief-inc-monitor">{i.project_name} · {i.monitor}</span>
                    <span className="muted">{i.detail}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="New intake" count={intake.length}>
              <ul className="brief-list">
                {intake.map((t) => (
                  <li key={t.id} className="brief-intake-row">
                    <span className="chip chip-intake">unreviewed</span>
                    <Link className="brief-intake-title" to={`/tasks/${t.id}`} state={{ backgroundLocation: location }}>{t.title}</Link>
                    <span className="chip">{t.project_name}</span>
                  </li>
                ))}
              </ul>
            </Section>

            {spend && spendCount > 0 && (
              <section className="brief-section">
                <h2 className="brief-h">Spend</h2>
                <div className="brief-spend">
                  <span className="brief-spend-total">{fmtUsd(spend.totals.cost_usd)}</span>
                  <span className="muted">{fmtTokens(spend.totals.total_tokens)} processed · {fmtTokens(spend.totals.input_tokens)} fresh · {fmtTokens(spend.totals.cache_read_tokens)} cached · {fmtTokens(spend.totals.output_tokens)} output · {fmtTokens(spend.totals.cache_write_tokens)} cache write · {spend.totals.calls} calls</span>
                  {spend.by_model[0] && <span className="brief-spend-model">top: {spend.by_model[0].model} ({fmtUsd(spend.by_model[0].cost_usd)})</span>}
                </div>
              </section>
            )}

            <Section title="New learnings" count={learnings.length}>
              <ul className="brief-list">
                {learnings.map((l) => (
                  <li key={l.id} className="brief-learning-row">
                    <Link className="brief-learning-title" to="/learnings">{l.title}</Link>
                    <span className="chip">{l.project_name}</span>
                    {l.occurrences > 1 && <span className="muted">×{l.occurrences}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        </details>
      )}
    </div>
  );
}
