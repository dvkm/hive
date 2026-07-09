import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import type { Brief } from "../lib/api";
import { useStore } from "../lib/store";
import { relTime } from "../lib/time";
import { StatusDot, HEALTH_LABEL } from "../lib/ui";
import { DecisionCard } from "./DecisionCard";
import { AttentionRows, needsAttention } from "./attention";
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
  const { decisions, tasks } = useStore();
  const location = useLocation();

  // Default the window to the last time the brief was viewed (localStorage, same
  // pattern as the feed's last-seen). Read the stored marker now, then stamp this
  // visit so next time the window starts where this one opened.
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

  // The two interactive sections read from the live store so answering a card or
  // acting on a tray row updates in place via SSE. The digest sections read the
  // fetched snapshot.
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const openDecisions = decisions.filter((d) => !answered.has(d.id));
  const attention = tasks.filter(needsAttention);

  const done = data?.done ?? [];
  const fleet = data?.fleet ?? [];
  const incidents = data?.incidents ?? [];
  const intake = data?.intake ?? [];
  const learnings = data?.learnings_new ?? [];
  const spend = data?.spend;
  const spendCount = spend ? spend.totals.calls : 0;

  const anything =
    openDecisions.length + attention.length + done.length + fleet.length +
    incidents.length + intake.length + spendCount + learnings.length;

  return (
    <div className="brief">
      <header className="brief-top">
        <div>
          <h1 className="brief-title">Morning brief</h1>
          <div className="brief-since muted">
            Since {since ? relTime(since) : "the beginning"}
          </div>
        </div>
        <label className="brief-picker">
          <span className="muted">Since</span>
          <input
            type="datetime-local"
            value={since ? toLocalInput(since) : ""}
            max={toLocalInput(new Date().toISOString())}
            onChange={(e) => setSince(e.target.value ? new Date(e.target.value).toISOString() : undefined)}
          />
        </label>
      </header>

      {data && anything === 0 && (
        <div className="brief-quiet">
          <div className="empty-big">All quiet.</div>
          <div className="muted">Nothing needs you.</div>
        </div>
      )}

      {/* ① Decisions waiting — answerable right here (reuses the inbox card). */}
      <Section title="Decisions waiting" count={openDecisions.length}>
        <div className="brief-decisions">
          {openDecisions.map((d) => (
            <DecisionCard key={d.id} d={d} onDone={(id) => setAnswered((s) => new Set(s).add(id))} />
          ))}
        </div>
      </Section>

      {/* ② Needs attention — reuses the board's tray rows. */}
      <Section title="Needs attention" count={attention.length}>
        <div className="brief-attn">
          <AttentionRows tasks={attention} />
        </div>
      </Section>

      {/* ③ Done, with evidence-count chips linking to the task modal. */}
      <Section title="Done" count={done.length}>
        <ul className="brief-list">
          {done.map((t) => (
            <li key={t.id} className="brief-done-row">
              <Link className="brief-done-title" to={`/tasks/${t.id}`} state={{ backgroundLocation: location }}>
                {t.title}
              </Link>
              <span className="chip">{t.project_name}</span>
              {t.summary && <span className="brief-done-summary muted">{t.summary}</span>}
              <Link
                className="brief-evc"
                to={`/tasks/${t.id}`}
                state={{ backgroundLocation: location }}
                title="Evidence"
              >
                ◱ {t.evidence_count}
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      {/* ④ Fleet now — live agents + health. */}
      <Section title="Fleet now" count={fleet.length}>
        <ul className="brief-list">
          {fleet.map((t) => (
            <li key={t.id} className="brief-fleet-row">
              <StatusDot state={t.state} health={t.health} />
              <Link className="brief-fleet-title" to={`/tasks/${t.id}`} state={{ backgroundLocation: location }}>
                {t.title}
              </Link>
              <span className={`brief-health attn-${t.health?.status ?? "healthy"}`}>
                {t.health ? t.health.reason || HEALTH_LABEL[t.health.status] : "working"}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      {/* ⑤ Incidents opened/resolved in the window. */}
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

      {/* ⑥ New intake awaiting review. */}
      <Section title="New intake" count={intake.length}>
        <ul className="brief-list">
          {intake.map((t) => (
            <li key={t.id} className="brief-intake-row">
              <span className="chip chip-intake">unreviewed</span>
              <Link className="brief-intake-title" to={`/tasks/${t.id}`} state={{ backgroundLocation: location }}>
                {t.title}
              </Link>
              <span className="chip">{t.project_name}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* ⑦ Spend — total + top model. */}
      {spend && spendCount > 0 && (
        <section className="brief-section">
          <h2 className="brief-h">Spend</h2>
          <div className="brief-spend">
            <span className="brief-spend-total">{fmtUsd(spend.totals.cost_usd)}</span>
            <span className="muted">
              {fmtTokens(spend.totals.total_tokens)} tokens · {spend.totals.calls} calls
            </span>
            {spend.by_model[0] && (
              <span className="brief-spend-model">
                top: {spend.by_model[0].model} ({fmtUsd(spend.by_model[0].cost_usd)})
              </span>
            )}
          </div>
        </section>
      )}

      {/* ⑧ New learnings. */}
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
  );
}
