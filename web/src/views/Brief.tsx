import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import type { Brief } from "../lib/api";
import { useStore } from "../lib/store";
import { StatusDot, HEALTH_LABEL } from "../lib/ui";
import { DecisionCard } from "./DecisionCard";
import { ReviewAudit, ReviewCard, ReviewUnderstanding } from "./ReviewCard";
import { AttentionRows } from "./attention";
import { CheckpointsInbox } from "./Checkpoints";
import { UnderstandingQuiz } from "./UnderstandingQuiz";
import { fmtUsd, fmtTokens } from "./Analytics";

const LAST_SEEN_KEY = "hive.brief.lastSeen";

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

export default function Brief() {
  const { needsYou, reloadQuizzes } = useStore();
  const location = useLocation();

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
    api.morningBrief(since).then((b) => live && setData(b)).catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [since]);

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
  const quizzes = needsYou.flatMap((item) => item.kind === "quiz" && !passedQuizzes.has(item.id) ? [item.quiz] : []);
  const toReview = needsYou.flatMap((item) => item.kind === "review" && !reviewed.has(item.id) ? [item.task] : []);
  const attention = needsYou.flatMap((item) => item.kind === "attention" ? [item.task] : []);

  const done = data?.done ?? [];
  const fleet = data?.fleet ?? [];
  const incidents = data?.incidents ?? [];
  const intake = data?.intake ?? [];
  const learnings = data?.learnings_new ?? [];
  const spend = data?.spend;
  const spendCount = spend ? spend.totals.calls : 0;

  const actionCount = openDecisions.length + checkpoints.length + quizzes.length + toReview.length + attention.length;

  return (
    <div className="brief-page">
      <header className="brief-top">
        <div>
          <h1 className="brief-title">Needs you</h1>
          <div className="brief-since muted">
            Decisions, approvals, and issues Hive cannot finish without you.
          </div>
        </div>
      </header>

      {data && actionCount === 0 && (
        <div className="brief-quiet">
          <div className="empty-big">All quiet.</div>
          <div className="muted">Nothing needs you.</div>
        </div>
      )}

      <Section title="Understanding backlog" count={quizzes.length}>
        {quizzes[0] && (
          <div className="brief-quiz">
            <Link to={`/tasks/${quizzes[0].task_id}`}>#{quizzes[0].task_number} {quizzes[0].task_title}</Link>
            <details className="review-details" open>
              <summary>
                <span>{quizzes[0].task_kind === "scout" ? "Explain report" : "Understand this change"}</span>
                <small>Read before answering</small>
              </summary>
              <div className="review-details-body">
                {quizzes[0].report.understanding && (
                  <ReviewUnderstanding
                    packet={quizzes[0].report.understanding}
                    report={quizzes[0].task_kind === "scout"}
                    caveats={quizzes[0].report.iffy}
                  />
                )}
                <ReviewAudit r={quizzes[0].report} />
              </div>
            </details>
            <UnderstandingQuiz
              quiz={quizzes[0]}
              onPassed={() => {
                setPassedQuizzes((items) => new Set(items).add(quizzes[0].id));
                reloadQuizzes();
              }}
            />
          </div>
        )}
        {quizzes.length > 1 && <div className="brief-queue-note">Next quiz appears after this one.</div>}
      </Section>

      {/* ① Decisions waiting, answerable here with the shared decision card. */}
      <Section title="Decisions waiting" count={openDecisions.length}>
        <div className="brief-decisions">
          {openDecisions[0] && <DecisionCard key={openDecisions[0].id} d={openDecisions[0]} onDone={(id) => setAnswered((s) => new Set(s).add(id))} />}
          {openDecisions.length > 1 && <div className="brief-queue-note">Next decision appears after this one.</div>}
        </div>
      </Section>

      <Section title="Checkpoints" count={checkpoints.length}>
        <CheckpointsInbox limit={1} heading={false} />
        {checkpoints.length > 1 && <div className="brief-queue-note">Next checkpoint appears after this one.</div>}
      </Section>

      {/* ②a To review — in-review tasks awaiting review & merge (shared card). */}
      <Section title="To review" count={toReview.length}>
        <div className="brief-reviews">
          {toReview[0] && <ReviewCard task={toReview[0]} onDone={() => setReviewed((s) => new Set(s).add(toReview[0].id))} />}
          {toReview.length > 1 && <div className="brief-queue-note">Next review appears after this one.</div>}
        </div>
      </Section>

      {/* ② Needs attention — reuses the board's tray rows. */}
      <Section title="Needs attention" count={attention.length}>
        <div className="brief-attn">
          <AttentionRows tasks={attention.slice(0, 1)} />
        </div>
        {attention.length > 1 && <div className="brief-queue-note">Next issue appears after this one.</div>}
      </Section>

      {data && (
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
                  <span className="muted">{fmtTokens(spend.totals.total_tokens)} tokens · {spend.totals.calls} calls</span>
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
