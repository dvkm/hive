import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { Decision, Evidence, TaskDetail } from "../lib/api";
import { useStore } from "../lib/store";
import { CiBadge, HEALTH_LABEL, NEXT, STATE_LABEL, StatusDot, toast } from "../lib/ui";
import { relTime } from "../lib/time";
import { useLightbox } from "../lib/lightbox";
import type { LightboxImage } from "../lib/lightbox";
import { fmtTokens, fmtUsd } from "./Analytics";

// Compact per-task usage line: tokens + estimated cost, only when usage exists.
function UsageLine({ id, rev }: { id: string; rev: number }) {
  const [tot, setTot] = useState<{ total_tokens: number; cost_usd: number; unpriced: number; calls: number } | null>(null);
  useEffect(() => {
    let live = true;
    api.taskUsage(id).then((d) => live && setTot(d.totals)).catch(() => {});
    return () => {
      live = false;
    };
  }, [id, rev]);
  if (!tot || tot.calls === 0) return null;
  return (
    <div className="task-usage" title={`${tot.calls} LLM call(s)`}>
      <span className="tu-tok">{fmtTokens(tot.total_tokens)} tokens</span>
      <span className="tu-cost">
        {tot.unpriced > 0 && tot.cost_usd === 0 ? "unpriced" : `~${fmtUsd(tot.cost_usd)}`}
      </span>
    </div>
  );
}

function EvidenceItem({ e, onOpen }: { e: Evidence; onOpen?: () => void }) {
  if (e.kind === "screenshot" && e.url) {
    return (
      <button className="ev-img" onClick={onOpen} title="Open">
        <img src={e.url} alt={e.caption || "screenshot"} />
        <span className="ev-cap">{e.caption}</span>
      </button>
    );
  }
  const href = e.url || undefined;
  const inner = (
    <>
      <div className="ev-card-head">
        <span className={`chip chip-kind`}>{e.kind}</span>
        <span className="ev-cap">{e.caption || e.path || e.url}</span>
      </div>
      {e.preview && <pre className="ev-preview">{e.preview}</pre>}
    </>
  );
  return href ? (
    <a className="ev-card" href={href} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    <div className="ev-card">{inner}</div>
  );
}

function DecisionMini({ d }: { d: Decision }) {
  const answered = d.status !== "open";
  return (
    <div className={`dmini ${answered ? "dmini-done" : "dmini-open"}`}>
      <div className="dmini-head">
        <strong>{d.title}</strong>
        <span className={`chip chip-risk risk-${d.risk || "unknown"}`}>{d.risk || "?"}</span>
      </div>
      {answered ? (
        <div className="dmini-answer">
          Answered: <code>{d.answer_key}</code>
          {d.answer_note && <> — {d.answer_note}</>}
        </div>
      ) : (
        <Link className="btn btn-primary" to="/decisions">
          Answer in inbox →
        </Link>
      )}
    </div>
  );
}

export default function TaskPage() {
  const { id = "" } = useParams();
  return <TaskBody id={id} />;
}

// The task detail content, shared by the standalone /tasks/:id route and the
// board modal (see App.tsx / views/TaskModal.tsx).
export function TaskBody({ id }: { id: string }) {
  const { rev, projects, tasks } = useStore();
  const lightbox = useLightbox();
  const [t, setT] = useState<TaskDetail | null>(null);
  const [err, setErr] = useState<string>("");
  const [steer, setSteer] = useState("");
  const [planning, setPlanning] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .task(id)
      .then((d) => live && setT(d))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [id, rev[id]]);

  if (err) return <div className="pad">Task not found: {err}</div>;
  if (!t) return <div className="pad">Loading…</div>;

  const project = projects.find((p) => p.id === t.project_id);
  const events = [...t.events].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const openDecisions = t.decisions.filter((d) => d.status === "open");
  const pastDecisions = t.decisions.filter((d) => d.status !== "open");
  const children = tasks.filter((x) => x.parent_task_id === t.id);
  const parent = t.parent_task_id ? tasks.find((x) => x.id === t.parent_task_id) : undefined;

  const doTransition = async (to: string) => {
    try {
      await api.transition(t.id, to as TaskDetail["state"]);
      toast(`→ ${STATE_LABEL[to as TaskDetail["state"]]}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const sendSteer = async () => {
    if (!steer.trim()) return;
    try {
      await api.send(t.id, steer);
      toast("Steer sent");
      setSteer("");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const planBreakdown = async () => {
    if (planning) return;
    setPlanning(true);
    try {
      const r = await api.plan(t.id);
      toast(r.ok ? "Breakdown proposed — answer in Decisions" : `Planner failed: ${r.error}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };
  const dispatch = async () => {
    if (!t) return;
    try {
      await api.spawn(t.id);
      toast("Agent dispatched");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const viewAgent = async () => {
    try {
      const r = await api.focusAgent(t.id);
      toast(r.ok ? "Focused agent tab in herdr" : `Can't focus: ${r.error}`);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const nudge = async () => {
    try {
      await api.send(t.id, "hive: status? Reply with what you just did / are doing, or what's blocking you.");
      toast("Status nudge sent");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const failRequeue = async () => {
    try {
      await api.requeue(t.id);
      toast("Failed & requeued as a fresh task");
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const health = t.health;
  const unhealthy = health && health.status !== "healthy";

  return (
    <div className="task">
      <div className="task-main">
        <div className="crumbs">
          <Link to="/">← Board</Link>
          {parent && (
            <>
              {" · "}
              <Link to={`/tasks/${parent.id}`}>↰ Parent: {parent.title}</Link>
            </>
          )}
        </div>
        <h1 className="task-title">
          <StatusDot state={t.state} health={t.health} /> {t.title}
        </h1>
        <div className="task-sub">
          {project && <span className="chip">{project.name}</span>}
          <span className={`chip chip-kind chip-${t.kind}`}>{t.kind}</span>
          <span className="chip">{STATE_LABEL[t.state]}</span>
          <UsageLine id={t.id} rev={rev[t.id] || 0} />
        </div>

        {unhealthy && (
          <div className={`health-banner banner-${health!.status}`}>
            <div className="health-banner-text">
              <strong>{HEALTH_LABEL[health!.status]}</strong>
              {health!.reason ? ` — ${health!.reason}` : ""} · since {relTime(health!.since)}
            </div>
            <div className="health-banner-actions">
              {t.agent_target && (
                <button className="btn btn-mini" onClick={viewAgent}>
                  View agent
                </button>
              )}
              {t.agent_target && (
                <button className="btn btn-mini" onClick={nudge}>
                  Nudge
                </button>
              )}
              <button className="btn btn-mini btn-danger" onClick={failRequeue}>
                Fail + requeue
              </button>
            </div>
          </div>
        )}

        <section className="panel">
          <h2>Brief</h2>
          <pre className="brief">{t.brief || "(no brief)"}</pre>
        </section>

        {children.length > 0 && (
          <section className="panel">
            <h2>Breakdown ({children.length})</h2>
            <ul className="breakdown">
              {children.map((c) => (
                <li key={c.id}>
                  <StatusDot state={c.state} />
                  <Link to={`/tasks/${c.id}`}>{c.title}</Link>
                  <span className={`chip chip-kind chip-${c.kind}`}>{c.kind}</span>
                  <span className="chip">{STATE_LABEL[c.state]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(openDecisions.length > 0 || pastDecisions.length > 0) && (
          <section className="panel">
            <h2>Decisions</h2>
            {openDecisions.map((d) => (
              <DecisionMini key={d.id} d={d} />
            ))}
            {pastDecisions.map((d) => (
              <DecisionMini key={d.id} d={d} />
            ))}
          </section>
        )}

        {t.evidence.length > 0 && (() => {
          // Image evidence forms one lightbox set; each thumbnail opens at its
          // own position so the arrows walk the whole task's images.
          const imgs = t.evidence.filter((e) => e.kind === "screenshot" && e.url);
          const lb: LightboxImage[] = imgs.map((e) => ({
            url: e.url!,
            caption: e.caption,
            taskId: t.id,
            taskTitle: t.title,
            ts: e.ts,
          }));
          return (
            <section className="panel">
              <h2>Evidence ({t.evidence.length})</h2>
              <div className="ev-gallery">
                {t.evidence.map((e) => (
                  <EvidenceItem
                    key={e.id}
                    e={e}
                    onOpen={
                      e.kind === "screenshot" && e.url
                        ? () => lightbox.open(lb, imgs.findIndex((x) => x.id === e.id))
                        : undefined
                    }
                  />
                ))}
              </div>
            </section>
          );
        })()}

        <section className="panel">
          <h2>Timeline</h2>
          <ul className="timeline">
            {events.map((ev) => (
              <li key={ev.id}>
                <span className={`src src-${ev.source}`}>{ev.source}</span>
                <span className="tl-type">{ev.type}</span>
                <span className="tl-note">
                  {(ev.payload?.note as string) ||
                    (ev.payload?.to
                      ? `${ev.payload.from} → ${ev.payload.to}`
                      : "") ||
                    (ev.payload?.caption as string) ||
                    (ev.payload?.title as string) ||
                    ""}
                </span>
                <span className="tl-age" title={ev.ts}>
                  {relTime(ev.ts)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <aside className="task-side">
        <section className="panel">
          <h2>PR / CI</h2>
          {t.pr_url ? (
            <a className="pr pr-lg" href={t.pr_url} target="_blank" rel="noreferrer">
              View PR
            </a>
          ) : (
            <div className="muted">No PR yet</div>
          )}
          <div className="ci-row">
            <CiBadge status={t.ci_status} />
          </div>
        </section>

        {t.summary && (
          <section className="panel">
            <h2>Summary</h2>
            <p>{t.summary}</p>
          </section>
        )}

        <section className="panel">
          <h2>Actions</h2>
          <div className="steer">
            <textarea
              placeholder="Steer message to the agent…"
              value={steer}
              onChange={(e) => setSteer(e.target.value)}
            />
            <button className="btn" onClick={sendSteer}>
              Send steer
            </button>
          </div>
          {t.agent_target && (
            <button className="btn" onClick={viewAgent} title="Focus this agent's tab in herdr">
              View agent
            </button>
          )}
          {t.state === "queued" && (
            <button className="btn btn-primary" onClick={dispatch}>
              Dispatch now
            </button>
          )}
          <button className="btn" onClick={planBreakdown} disabled={planning}>
            {planning ? "Planning…" : "Plan breakdown"}
          </button>
          <div className="transitions">
            {(NEXT[t.state] || []).map((to) => (
              <button
                key={to}
                className={`btn ${to === "cancelled" || to === "failed" ? "btn-danger" : "btn-primary"}`}
                onClick={() => doTransition(to)}
              >
                {STATE_LABEL[to]}
              </button>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}
