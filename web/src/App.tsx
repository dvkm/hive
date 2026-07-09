import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { Location } from "react-router-dom";
import { useStore } from "./lib/store";
import { relTime } from "./lib/time";
import Board from "./views/Board";
import Brief from "./views/Brief";
import Feed from "./views/Feed";
import Evidence from "./views/Evidence";
import TaskPage from "./views/Task";
import TaskModal from "./views/TaskModal";
import Decisions from "./views/Decisions";
import Review from "./views/Review";
import Policies from "./views/Policies";
import Monitors from "./views/Monitors";
import Learnings from "./views/Learnings";
import Analytics from "./views/Analytics";
import Projects from "./views/Projects";
import Palette from "./views/Palette";

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
  const { decisions, tasks } = useStore();
  const reviewCount = tasks.filter((t) => t.state === "in_review").length;
  const location = useLocation();
  // Board card clicks push /tasks/:id with state.backgroundLocation set to the
  // board's location — that keeps the board mounted and rendered underneath
  // while a modal Route renders the task on top. Direct loads (deep links,
  // notifications, refresh) carry no such state, so /tasks/:id just renders
  // the standalone page as usual.
  const background = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> hive
        </div>
        <nav className="nav">
          <NavLink to="/brief">Brief</NavLink>
          <NavLink to="/" end>
            Board
          </NavLink>
          <NavLink to="/feed">Feed</NavLink>
          <NavLink to="/evidence">Evidence</NavLink>
          <NavLink to="/decisions">
            Decisions
            {decisions.length > 0 && <span className="badge">{decisions.length}</span>}
          </NavLink>
          <NavLink to="/review">
            Review
            {reviewCount > 0 && <span className="badge">{reviewCount}</span>}
          </NavLink>
          <NavLink to="/learnings">Learnings</NavLink>
          <NavLink to="/analytics">Analytics</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/policies">Policies</NavLink>
          <NavLink to="/monitors">Monitors</NavLink>
        </nav>
        <Bell />
        <ConnDot />
      </header>
      <main className="content">
        <Routes location={background || location}>
          <Route path="/" element={<Board />} />
          <Route path="/brief" element={<Brief />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/evidence" element={<Evidence />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/decisions" element={<Decisions />} />
          <Route path="/review" element={<Review />} />
          <Route path="/learnings" element={<Learnings />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/monitors" element={<Monitors />} />
        </Routes>
      </main>
      {background && (
        <Routes>
          <Route path="/tasks/:id" element={<TaskModal />} />
        </Routes>
      )}
      <Palette />
    </div>
  );
}
