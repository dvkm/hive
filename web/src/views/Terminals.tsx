// Fleet terminals: every live agent's pane at a glance, plus a status strip.
// Read-only mini panes (poll the /pane endpoint); click through for the full
// task page with steer input.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { State } from "../lib/api";
import { useStore } from "../lib/store";
import { STATE_LABEL, StatusDot } from "../lib/ui";

const ACTIVE: State[] = ["in_progress", "needs_decision", "in_review", "verifying"];

function MiniPane({ id }: { id: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    let live = true;
    const tick = () =>
      api
        .pane(id, 60)
        .then((r) => live && setText(r.text))
        .catch(() => live && setText("(pane unavailable)"));
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  return <pre className="term term-mini">{text || "…"}</pre>;
}

export default function Terminals() {
  const { tasks, decisions } = useStore();
  const counts = (["queued", ...ACTIVE] as State[]).map((s) => ({
    state: s,
    n: tasks.filter((t) => t.state === s).length,
  }));
  const live = tasks.filter((t) => ACTIVE.includes(t.state) && t.agent_target);
  return (
    <div className="pad">
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
      <div className="fleet-grid">
        {live.map((t) => (
          <div className="fleet-cell" key={t.id}>
            <div className="fleet-head">
              <StatusDot state={t.state} />
              <Link to={`/tasks/${t.id}`} className="fleet-title">
                #{t.number} {t.title}
              </Link>
              <span className="chip">{STATE_LABEL[t.state]}</span>
            </div>
            <MiniPane id={t.id} />
          </div>
        ))}
        {!live.length && <div className="muted pad">No live agents right now.</div>}
      </div>
    </div>
  );
}
