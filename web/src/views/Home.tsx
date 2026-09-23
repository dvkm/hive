import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import type { Digest, DigestProject, Task } from "../lib/api";
import { keepTrying, useStore } from "../lib/store";
import { actionableItems, orderFocusItems } from "../lib/needsYou";
import { inProjectFilter, setProjectFilter, useProjectFilter } from "../lib/projectFilter";
import { PrReference, prLabel } from "../lib/references";
import { toast } from "../lib/ui";
import { DecisionCard } from "./DecisionCard";
import { IntentCard } from "./IntentCard";
import { HeldSummary } from "./Away";
import { FirstProject } from "./Chat";

// Home: the calls only the director can make, then one digest of what hive
// handled since the last look. Everything else is behind Details.

const SHOWN = 3;
const REFRESH_MS = 60_000;

export default function Home() {
  const { needsYou, tasks, projects, projectsLoaded, decisionsLoaded, reloadIntents } = useStore();
  const projectFilter = useProjectFilter();
  // Answered here: gone at once, without waiting for the stream to confirm.
  const [handled, setHandled] = useState<string[]>([]);
  const calls = orderFocusItems(actionableItems(needsYou, tasks, projectFilter), tasks).filter((item) => !handled.includes(item.id));
  const done = (id: string) => setHandled((ids) => [...ids, id]);
  const scope = projects.find((p) => p.id === projectFilter);

  if (projectsLoaded && projects.length === 0)
    return (
      <div className="home">
        <FirstProject />
      </div>
    );

  const count = calls.length;
  return (
    <div className="home">
      <h1 className="home-headline">
        {!decisionsLoaded
          ? "Checking what needs you."
          : count === 0
            ? "Nothing needs you."
            : `${count} ${count === 1 ? "thing needs" : "things need"} you.`}
      </h1>
      {scope && (
        <p className="home-scope">
          Showing {scope.name} only. <button className="link-btn" onClick={() => setProjectFilter("")}>Show all projects</button>
        </p>
      )}
      {count > 0 && (
        <div className="home-calls">
          {calls.slice(0, SHOWN).map((item) =>
            item.kind === "decision" ? (
              <div className="home-call" key={`decision:${item.id}`}>
                {item.decision.advice && <p className="home-why">{item.decision.advice}</p>}
                <DecisionCard d={item.decision} onDone={done} />
              </div>
            ) : item.kind === "intent" ? (
              <div className="home-call" key={`intent:${item.id}`}>
                <IntentCard intent={item.intent} onChange={reloadIntents} brief />
              </div>
            ) : (
              <ReviewCall key={`review:${item.id}`} task={item.task} onDone={() => done(item.id)} />
            )
          )}
          {count > SHOWN && <p className="home-more">{count - SHOWN} more after these.</p>}
        </div>
      )}
      <HeldSummary />
      <DigestSection projectFilter={projectFilter} />
    </div>
  );
}

// A review that waits for the director's own Ship. The full card, with the
// diff and the evidence, is one click away on the task page.
function ReviewCall({ task, onDone }: { task: Task; onDone: () => void }) {
  const { projects } = useStore();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const project = projects.find((p) => p.id === task.project_id);
  const report = task.kind === "scout";

  const ship = async () => {
    setBusy(true);
    try {
      if (report) await api.transition(task.id, "verifying");
      else await api.merge(task.id);
      toast(report ? "Report accepted" : "Shipped");
      onDone();
    } catch (e) {
      toast(`Not shipped: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const sendNotes = async () => {
    if (!notes?.trim()) return;
    setBusy(true);
    try {
      const r = await api.requestChanges(task.id, notes.trim());
      toast(r.delivered ? "Sent to the agent." : "Saved. The agent gets it when it is back.");
      onDone();
    } catch (e) {
      toast(`Not sent: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="home-call home-review">
      <div className="home-review-meta">
        <span>Review</span>
        {project && <span>{project.name}</span>}
        {task.pr_url && <PrReference url={task.pr_url} label={`${prLabel(task.pr_url)} ↗`} />}
      </div>
      <h2 className="home-review-title">
        <Link to={`/tasks/${task.id}`} state={{ backgroundLocation: location }}>{task.title}</Link>
      </h2>
      {task.review_hold && <p className="home-why">{task.review_hold}</p>}
      <div className="home-review-actions">
        <button className="btn btn-primary" disabled={busy} onClick={ship}>
          {busy ? "Working…" : report ? "Accept report" : "Ship"}
        </button>
        {!task.never_dispatched && (
          <button className="btn" disabled={busy} onClick={() => setNotes(notes === null ? "" : null)}>
            Request changes
          </button>
        )}
      </div>
      {notes !== null && (
        <div className="review-notes">
          <textarea autoFocus placeholder="What needs to change? The agent gets this note." value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || !notes.trim()} onClick={sendNotes}>
            Send to the agent
          </button>
        </div>
      )}
    </article>
  );
}

function hasNews(p: DigestProject): boolean {
  return !!(
    p.shipped_total ||
    p.decided.length ||
    p.stuck.length ||
    p.waiting_on_others.length ||
    p.new_requests.length ||
    p.reports?.length ||
    p.working_total ||
    p.queued ||
    p.github_error
  );
}

function DigestSection({ projectFilter }: { projectFilter: string }) {
  const { feedEvents } = useStore();
  const [digest, setDigest] = useState<Digest | null>(null);
  const [failed, setFailed] = useState(false);
  const since = useRef<string | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const lastFetch = useRef(0);

  // The first load marks this look, so the next window starts here. Later
  // loads pin the same window, so the list never shrinks while it is read.
  const load = () => {
    if (pending.current) return pending.current;
    lastFetch.current = Date.now();
    pending.current = api
      .digest(since.current === null, since.current ?? undefined)
      .then((d) => {
        since.current ??= d.since;
        setDigest(d);
        setFailed(false);
      })
      .catch((e) => {
        setFailed(true);
        throw e;
      })
      .finally(() => {
        pending.current = null;
      });
    return pending.current;
  };
  useEffect(() => keepTrying(load).stop, []);

  // New activity refreshes it, at most once a minute.
  const pulse = feedEvents[0]?.id ?? "";
  const firstPulse = useRef(pulse);
  useEffect(() => {
    if (pulse === firstPulse.current) return;
    const timer = setTimeout(() => load().catch(() => {}), Math.max(0, lastFetch.current + REFRESH_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [pulse]);

  if (!digest) return failed ? <p className="muted home-note">Could not load what changed. Hive keeps trying.</p> : null;
  const shown = digest.projects.filter((p) => inProjectFilter(p.id, projectFilter) && hasNews(p));
  return (
    <section className="home-digest">
      <h2 className="home-h" title={`From ${new Date(digest.since).toLocaleString()}`}>Since you last looked</h2>
      {shown.length === 0 ? <p className="muted home-note">Nothing new.</p> : shown.map((p) => <ProjectDigest key={p.id} p={p} />)}
    </section>
  );
}

function DigestList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="home-list">
      <h3>{title}</h3>
      <ul>{children}</ul>
    </div>
  );
}

function ProjectDigest({ p }: { p: DigestProject }) {
  const location = useLocation();
  const taskLink = (id: string, label: string) => (
    <Link to={`/tasks/${id}`} state={{ backgroundLocation: location }}>{label}</Link>
  );
  const moreShipped = p.shipped_total - p.shipped.length;
  return (
    <details className="home-project" open>
      <summary>{p.name}</summary>
      {p.shipped_total > 0 && (
        <DigestList title="Shipped">
          {p.shipped.map((s, i) => (
            <li key={s.url || i}>
              <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
            </li>
          ))}
          {moreShipped > 0 && <li className="muted">+{moreShipped} more</li>}
        </DigestList>
      )}
      {p.reports?.length > 0 && (
        <DigestList title="Reports">
          {p.reports.map((r) => (
            <li key={r.task_id}>
              {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : taskLink(r.task_id, r.title)}
            </li>
          ))}
        </DigestList>
      )}
      {p.decided.length > 0 && (
        <DigestList title="Hive decided">
          {p.decided.map((d) => (
            <li key={d.decision_id}>
              {taskLink(d.task_id, d.question)} <span className="home-answer">→ {d.answer}</span>
              {d.why && <span className="home-detail">{d.why.replace(/^hive decided:\s*/i, "")}</span>}
            </li>
          ))}
        </DigestList>
      )}
      {p.stuck.length > 0 && (
        <DigestList title="Stuck">
          {p.stuck.map((s) => (
            <li key={s.task_id}>
              {taskLink(s.task_id, s.title)}
              {s.reason && <span className="home-detail">{s.reason}</span>}
            </li>
          ))}
        </DigestList>
      )}
      {p.waiting_on_others.length > 0 && (
        <DigestList title="Waiting on others">
          {p.waiting_on_others.map((w) => (
            <li key={w.task_id}>
              Asked the reporter about {taskLink(w.task_id, w.key ?? w.title)}
              {w.key && <span className="home-detail">{w.title}</span>}
            </li>
          ))}
        </DigestList>
      )}
      {p.new_requests.length > 0 && (
        <DigestList title="New requests">
          {p.new_requests.map((r) => (
            <li key={r.task_id}>{taskLink(r.task_id, r.key ? `${r.key}: ${r.title}` : r.title)}</li>
          ))}
        </DigestList>
      )}
      <p className="home-motion">
        {p.working_total} in progress, {p.queued} queued
      </p>
      {p.github_error && (
        <p className="home-note muted" title={p.github_error}>
          GitHub did not answer, so the shipped list may be short.
        </p>
      )}
    </details>
  );
}
