// Fleet terminals: what every live agent is saying, at a glance, plus a status
// strip. The default is the agent's transcript (its `assistant_text` events,
// which the hooks lift from the agent's own transcript file), not a scrape of
// the terminal screen: no TUI chrome, no spinners, just the words. The raw pane
// is one toggle away for when the screen itself is the question.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { State } from "../lib/api";
import { useStore } from "../lib/store";
import { Empty, STATE_LABEL, StatusDot } from "../lib/ui";
import { isTrackingOnly } from "../lib/needsYou";
import { taskLabel } from "../lib/references";
import { relTime } from "../lib/time";

const ACTIVE: State[] = ["in_progress", "needs_decision", "in_review", "verifying"];
const LAST = 6;

function MiniPane({ id }: { id: string }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let live = true;
    const tick = () =>
      api
        .pane(id, 60)
        .then((r) => {
          if (!live) return;
          setText(r.text);
          // Always follow the tail.
          requestAnimationFrame(() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          });
        })
        .catch(() => live && setText("(pane unavailable)"));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  return (
    <pre className="term term-mini" ref={ref}>
      {text || "…"}
    </pre>
  );
}

// The last few things the agent said, newest at the bottom.
function MiniTranscript({ id }: { id: string }) {
  const [lines, setLines] = useState<{ id: string; ts: string; text: string }[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const tick = () =>
      api
        .task(id)
        .then((t) => {
          if (!live) return;
          const said = (t.events ?? [])
            .filter((e) => e.type === "assistant_text" && String(e.payload?.text ?? "").trim())
            .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
            .slice(-LAST)
            .map((e) => ({ id: e.id, ts: e.ts, text: String(e.payload.text) }));
          setLines(said);
          requestAnimationFrame(() => {
            if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
          });
        })
        .catch(() => live && setLines([]));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  if (lines === null) return <div className="term-transcript muted">…</div>;
  if (!lines.length) return <div className="term-transcript muted">Nothing said yet.</div>;
  return (
    <div className="term-transcript" ref={ref}>
      {lines.map((l) => (
        <div className="term-said" key={l.id}>
          <span className="term-said-age" title={l.ts}>{relTime(l.ts)}</span>
          <span className="term-said-text">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

export default function Terminals() {
  const { tasks, decisions } = useStore();
  const [raw, setRaw] = useState(false);
  const counts = (["queued", ...ACTIVE] as State[]).map((s) => ({
    state: s,
    n: tasks.filter((t) => t.state === s).length,
  }));
  const live = tasks.filter((t) => ACTIVE.includes(t.state) && t.agent_target && !isTrackingOnly(t));
  return (
    <div className="pad">
      <div className="page-head">
        <h1 className="page-title">Terminals</h1>
        <p className="page-sub">What every live agent is saying. Click a title to open the task and steer it.</p>
      </div>
      <div className="fleet-strip">
        {counts.map((c) => (
          <span key={c.state} className="chip">
            <StatusDot state={c.state} /> {STATE_LABEL[c.state]}: {c.n}
          </span>
        ))}
        <Link to="/decisions" className="chip">
          open decisions: {decisions.length}
        </Link>
        <label className="chip fleet-raw">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> raw screens
        </label>
      </div>
      {live.length === 0 ? (
        <Empty
          title="No agents running"
          hint="Agents appear here the moment a task is dispatched. Dispatch one from the board to watch it work."
        />
      ) : (
        <div className="fleet-grid">
          {live.map((t) => (
            <section className="panel fleet-cell" key={t.id}>
              <header className="fleet-head">
                <StatusDot state={t.state} />
                <Link to={`/tasks/${t.id}`} className="fleet-title">
                  {taskLabel(t)} {t.title}
                </Link>
                <span className="chip">{STATE_LABEL[t.state]}</span>
              </header>
              {raw ? <MiniPane id={t.id} /> : <MiniTranscript id={t.id} />}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
