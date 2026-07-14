import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { Location } from "react-router-dom";
import { useStore } from "./lib/store";
import { relTime } from "./lib/time";
import { toast } from "./lib/ui";
import { pushState, enablePush } from "./lib/push";
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
import Terminals from "./views/Terminals";
import Analytics from "./views/Analytics";
import Projects from "./views/Projects";
import Palette from "./views/Palette";

// Enable web-push on this device (phone PWA). Hidden once granted or where
// unsupported (desktop keeps the osascript notifier). iOS only offers this on
// an installed PWA over HTTPS.
function PushButton() {
  const [state, setState] = useState(pushState());
  if (state === "granted" || state === "unsupported" || state === "denied") return null;
  return (
    <button
      className="offline-toggle"
      title="Get hive decisions & answers as notifications on this device"
      onClick={async () => {
        const msg = await enablePush();
        setState(pushState());
        toast(msg);
      }}
    >
      🔔 notify
    </button>
  );
}

// Mobile navigation: a fixed bottom tab bar (the 4 places you actually live in)
// plus a "More" sheet for everything else. Hidden on desktop via CSS; the top
// nav is hidden on mobile. Badges match the desktop nav.
function MobileNav({
  inboxCount,
  reviewCount,
  offline,
  setOffline,
}: {
  inboxCount: number;
  reviewCount: number;
  offline: boolean;
  setOffline: (v: boolean) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const close = () => setMoreOpen(false);
  const tab = (to: string, label: string, icon: string, badge = 0, end = false) => (
    <NavLink to={to} end={end} className="mobtab" onClick={close}>
      <span className="mobtab-icon">{icon}</span>
      {label}
      {badge > 0 && <span className="badge mobtab-badge">{badge}</span>}
    </NavLink>
  );
  const more = [
    ["/brief", "Brief", "📋"],
    ["/feed", "Feed", "📡"],
    ["/evidence", "Evidence", "🖼"],
    ["/learnings", "Learnings", "📚"],
    ["/analytics", "Analytics", "📊"],
    ["/projects", "Projects", "📁"],
    ["/policies", "Policies", "⚖️"],
    ["/monitors", "Monitors", "❤️"],
  ] as const;
  return (
    <>
      {moreOpen && (
        <div className="mobsheet-scrim" onClick={close}>
          <div className="mobsheet" onClick={(e) => e.stopPropagation()}>
            <div className="mobsheet-grid">
              {more.map(([to, label, icon]) => (
                <NavLink key={to} to={to} className="mobsheet-item" onClick={close}>
                  <span className="mobsheet-icon">{icon}</span>
                  {label}
                </NavLink>
              ))}
            </div>
            <button
              className={`btn ${offline ? "btn-danger" : ""} mobsheet-offline`}
              onClick={() => {
                setOffline(!offline);
                close();
              }}
            >
              {offline ? "⏸ Offline mode is ON — tap to resume" : "Go offline (drain the fleet)"}
            </button>
          </div>
        </div>
      )}
      <nav className="mobnav">
        {tab("/", "Board", "▦", 0, true)}
        {tab("/decisions", "Decisions", "◎", inboxCount)}
        {tab("/review", "Review", "✓", reviewCount)}
        {tab("/terminals", "Terminals", "▶")}
        <button className={`mobtab ${moreOpen ? "active" : ""}`} onClick={() => setMoreOpen((v) => !v)}>
          <span className="mobtab-icon">☰</span>
          More
        </button>
      </nav>
    </>
  );
}

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
  const { decisions, tasks, checkpoints, offline, setOffline } = useStore();
  const reviewCount = tasks.filter((t) => t.state === "in_review").length;
  const inboxCount = decisions.length + checkpoints.length;
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
            {inboxCount > 0 && <span className="badge">{inboxCount}</span>}
          </NavLink>
          <NavLink to="/review">
            Review
            {reviewCount > 0 && <span className="badge">{reviewCount}</span>}
          </NavLink>
          <NavLink to="/terminals">Terminals</NavLink>
          <NavLink to="/learnings">Learnings</NavLink>
          <button
            className={`offline-toggle ${offline ? "offline-on" : ""}`}
            title={
              offline
                ? "Offline mode is ON: nothing new spawns; agents parked with handoff notes. Click to resume."
                : "Prepare for losing internet: agents push WIP + write handoff notes and park; nothing new spawns."
            }
            onClick={() => setOffline(!offline)}
          >
            {offline ? "⏸ offline" : "go offline"}
          </button>
          <NavLink to="/analytics">Analytics</NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/policies">Policies</NavLink>
          <NavLink to="/monitors">Monitors</NavLink>
        </nav>
        <PushButton />
        <Bell />
        <ConnDot />
      </header>
      <MobileNav inboxCount={inboxCount} reviewCount={reviewCount} offline={offline} setOffline={setOffline} />
      <main className="content">
        <Routes location={background || location}>
          <Route path="/" element={<Board />} />
          <Route path="/brief" element={<Brief />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/evidence" element={<Evidence />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/decisions" element={<Decisions />} />
          <Route path="/review" element={<Review />} />
          <Route path="/terminals" element={<Terminals />} />
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
