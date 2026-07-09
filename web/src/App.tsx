import { useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { useStore } from "./lib/store";
import { relTime } from "./lib/time";
import Board from "./views/Board";
import TaskPage from "./views/Task";
import Decisions from "./views/Decisions";
import Policies from "./views/Policies";
import Monitors from "./views/Monitors";
import Learnings from "./views/Learnings";

function ConnDot() {
  const { sse } = useStore();
  const label = sse === "open" ? "live" : sse === "connecting" ? "connecting" : "reconnecting";
  return (
    <span className={`conn conn-${sse}`} title={`SSE ${label}`}>
      <span className="conn-dot" />
      {label}
    </span>
  );
}

// Header bell: unread count (notifications not yet delivered/seen) + a dropdown
// of recent notifications. Opening marks everything read.
function Bell() {
  const { notifications, ackNotifications } = useStore();
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((n) => !n.delivered_at).length;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) ackNotifications();
  };

  return (
    <div className="bell-wrap">
      <button className="bell" onClick={toggle} title="Notifications" aria-label="Notifications">
        <span className="bell-icon">🔔</span>
        {unread > 0 && <span className="badge bell-badge">{unread}</span>}
      </button>
      {open && (
        <div className="bell-drop">
          <div className="bell-head">Notifications</div>
          {notifications.length === 0 && <div className="muted pad">Nothing yet.</div>}
          {notifications.slice(0, 30).map((n) => (
            <div key={n.id} className={`ntf ntf-${n.urgency}`}>
              <div className="ntf-title">{n.title}</div>
              {n.body && <div className="ntf-body">{n.body}</div>}
              <div className="ntf-age" title={n.ts}>{relTime(n.ts)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { decisions } = useStore();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> hive
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Board
          </NavLink>
          <NavLink to="/decisions">
            Decisions
            {decisions.length > 0 && <span className="badge">{decisions.length}</span>}
          </NavLink>
          <NavLink to="/learnings">Learnings</NavLink>
          <NavLink to="/policies">Policies</NavLink>
          <NavLink to="/monitors">Monitors</NavLink>
        </nav>
        <Bell />
        <ConnDot />
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/decisions" element={<Decisions />} />
          <Route path="/learnings" element={<Learnings />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/monitors" element={<Monitors />} />
        </Routes>
      </main>
    </div>
  );
}
