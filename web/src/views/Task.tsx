import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { Decision, Evidence, TaskDetail } from "../lib/api";
import { useStore } from "../lib/store";
import { Attach, CiBadge, HEALTH_LABEL, NEXT, STATE_LABEL, StatusDot, toast } from "../lib/ui";
import { ReviewCard } from "./ReviewCard";
import { CheckpointList } from "./Checkpoints";
import { DecisionCard } from "./DecisionCard";
import { ReportView } from "./ReportView";
import { relTime } from "../lib/time";
import { useLightbox } from "../lib/lightbox";
import type { LightboxImage } from "../lib/lightbox";
import { fmtTokens, fmtUsd } from "./Analytics";
import { buildTimeline } from "../lib/timeline";
import type { TimelineItem } from "../lib/timeline";
import { eventText } from "../lib/eventText";

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
  const viewable = !!href && ["report", "log", "test_run"].includes(e.kind);
  const [open, setOpen] = useState(false);
  const head = (
    <div className="ev-card-head">
      <span className={`chip chip-kind`}>{e.kind}</span>
      <span className="ev-cap">{e.caption || e.path || e.url}</span>
      {href && (
        <a className="ev-ext" href={href} target="_blank" rel="noreferrer" title="Open raw file" onClick={(ev) => ev.stopPropagation()}>
          ↗
        </a>
      )}
    </div>
  );
  // Clicking a text-evidence card opens the inline viewer; the ↗ opens the raw
  // file. Link evidence keeps the whole card as an external anchor.
  if (viewable) {
    return (
      <div className={`ev-card ev-viewable ${open ? "ev-open" : ""}`} onClick={() => setOpen((o) => !o)}>
        {head}
        {e.preview && !open && <pre className="ev-preview">{e.preview}</pre>}
        {open && (
          <div onClick={(ev) => ev.stopPropagation()}>
            <ReportView url={href!} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="ev-card">
      {href ? (
        <a className="ev-card-link" href={href} target="_blank" rel="noreferrer">
          {head}
        </a>
      ) : (
        head
      )}
      {e.preview && <pre className="ev-preview">{e.preview}</pre>}
    </div>
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

// One timeline row, dispatched on the folded item kind. Transcript text and
// decision prompts render as prominent blocks; grouped tools collapse into an
// expandable "used N tools" row; everything else stays a quiet one-liner.
function TimelineRow({ it }: { it: TimelineItem }) {
  if (it.kind === "text") {
    return (
      <li className="tl-text">
        <div className="tl-text-head">
          <span className={`src src-${it.source}`}>{it.source}</span>
          <span className="tl-age" title={it.ts}>{relTime(it.ts)}</span>
        </div>
        <div className="tl-bubble">{it.text}</div>
      </li>
    );
  }

  if (it.kind === "tools") {
    return (
      <li className="tl-tools">
        <details>
          <summary>
            <span className="tl-tools-count">used {it.tools.length} tool{it.tools.length === 1 ? "" : "s"}</span>
            <span className="tl-chips">
              {it.tools.map((tl, i) => (
                <span key={i} className="chip chip-tool">{tl.tool}</span>
              ))}
            </span>
            <span className="tl-age" title={it.ts}>{relTime(it.ts)}</span>
          </summary>
          <ul className="tl-tool-list">
            {it.tools.map((tl, i) => (
              <li key={i}>
                <span className="chip chip-tool">{tl.tool}</span>
                {tl.summary && <code className="tl-tool-sum">{tl.summary}</code>}
              </li>
            ))}
          </ul>
        </details>
      </li>
    );
  }

  if (it.kind === "decision") {
    const d = it.decision;
    return (
      <li className="tl-decision">
        <div className="tl-decision-head">
          <span className="tl-decision-badge">🔶 {it.open ? "Awaiting your decision" : "Decision requested"}</span>
          <span className="tl-age" title={it.ts}>{relTime(it.ts)}</span>
        </div>
        <div className="tl-decision-q">{d.title}</div>
        {d.context && <div className="tl-decision-ctx">{d.context}</div>}
        {d.options && d.options.length > 0 && (
          <ul className="tl-decision-opts">
            {d.options.map((o) => (
              <li key={o.key} className={!it.open && o.key === d.answer_key ? "opt-chosen" : ""}>
                {o.label || o.key}
              </li>
            ))}
          </ul>
        )}
        {it.open ? (
          <Link className="btn btn-primary btn-mini" to="/decisions">Answer in inbox →</Link>
        ) : (
          <div className="tl-decision-answer">
            ✓ You answered: <strong>{it.answerLabel}</strong>
            {d.answer_note && <> — {d.answer_note}</>}
            {d.answered_at && <span className="tl-age"> · {relTime(d.answered_at)}</span>}
          </div>
        )}
      </li>
    );
  }

  const ev = it.ev;
  return (
    <li>
      <span className={`src src-${ev.source}`}>{ev.source}</span>
      <span className="tl-type">{ev.type}</span>
      <span className="tl-note">{eventText(ev)}</span>
      <span className="tl-age" title={ev.ts}>{relTime(ev.ts)}</span>
    </li>
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
  const [steerFiles, setSteerFiles] = useState<File[]>([]);
  const [planning, setPlanning] = useState(false);

  const refresh = () => api.task(id).then(setT).catch(() => {});

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
  const timeline = buildTimeline(t.events, t.decisions);
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
      const r = await api.send(t.id, steer, steerFiles);
      // Never a bare "sent" — a queued steer that read as delivered is what made
      // David re-send the same message three times.
      const files = r.attachments?.length ? ` with ${r.attachments.length} file(s)` : "";
      toast(
        r.delivered
          ? `Steer delivered${files}`
          : r.delivery === "failed"
            ? `Steer undelivered: ${r.error || "task is finished"}`
            : `No live agent — steer queued for the next spawn${files}`
      );
      setSteer("");
      setSteerFiles([]);
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
          <StatusDot state={t.state} health={t.health} />{" "}
          <span className="task-num" title="Task number">#{t.number}</span> {t.title}
        </h1>
        <div className="task-sub">
          {project && <span className="chip">{project.name}</span>}
          <span className={`chip chip-kind chip-${t.kind}`}>{t.kind}</span>
          <span className="chip">{STATE_LABEL[t.state]}</span>
          {t.duplicate_of && (
            <Link
              className="chip chip-duplicate"
              to={`/tasks/${t.duplicate_of}`}
              title="This task was cancelled as a duplicate; open the task it was folded into"
            >
              ⧉ duplicate of {tasks.find((x) => x.id === t.duplicate_of)?.title ?? `#${t.duplicate_of}`}
            </Link>
          )}
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

        {t.state === "in_review" && <ReviewCard task={t} onDone={refresh} defaultExpanded />}

        <CheckpointList events={t.events} />

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
            {/* Open cards are ANSWERABLE here — radios + note + submit, the same
                component as the inbox, so nobody is bounced to another page. */}
            {openDecisions.map((d) => (
              <DecisionCard key={d.id} d={d} onDone={() => refresh()} />
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
            {timeline.map((it) => (
              <TimelineRow key={it.id} it={it} />
            ))}
          </ul>
        </section>
      </div>

      <aside className="task-side">
        <section className="panel">
          <h2>PR / CI</h2>
          {t.pr_url ? (
            <a className="pr pr-lg" href={t.pr_url} target="_blank" rel="noreferrer" title={`Pull request linked to #${t.number}`}>
              View PR ↔ #{t.number}
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
            <Attach files={steerFiles} onChange={setSteerFiles}>
              <textarea
                placeholder="Steer message to the agent…"
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
              />
            </Attach>
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
