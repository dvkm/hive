// Fleet terminals: every live agent's pane at a glance, plus a status strip.
// Read-only mini panes (poll the /pane endpoint); click through for the full
// task page with steer input.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { State } from "../lib/api";
import { useStore } from "../lib/store";
import { Empty, STATE_LABEL, StatusDot } from "../lib/ui";
import { isTrackingOnly } from "../lib/needsYou";
import { taskLabel } from "../lib/references";

const ACTIVE: State[] = ["in_progress", "needs_decision", "in_review", "verifying"];

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

export default function Terminals() {
  const { tasks, decisions } = useStore();
  const counts = (["queued", ...ACTIVE] as State[]).map((s) => ({
    state: s,
    n: tasks.filter((t) => t.state === s).length,
  }));
  const live = tasks.filter((t) => ACTIVE.includes(t.state) && t.agent_target && !isTrackingOnly(t));
  return (
    <div className="pad">
      <div className="page-head">
        <h1 className="page-title">Terminals</h1>
        <p className="page-sub">Every live agent's pane. Click a title to open the task and steer it.</p>
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
      </div>
      {live.length === 0 ? (
        <Empty
          title="No agents running"
          hint="Panes appear here the moment a task is dispatched. Dispatch one from the board to watch it work."
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
              <MiniPane id={t.id} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
