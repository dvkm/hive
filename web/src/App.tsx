import { useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { Location } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faBell,
  faClipboard,
  faComments,
  faSatelliteDish,
  faImage,
  faBookOpen,
  faChartColumn,
  faFolder,
  faScaleBalanced,
  faHeart,
} from "@fortawesome/free-solid-svg-icons";
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
import Chat from "./views/Chat";
import Supervisors from "./views/Supervisors";
import { needsAttention } from "./views/attention";

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
      <FontAwesomeIcon icon={faBell} /> notify
    </button>
  );
}

const SECONDARY_NAV: { label: string; items: [string, string, IconDefinition][] }[] = [
  {
    label: "Observe",
    items: [
      ["/feed", "Activity", faSatelliteDish],
      ["/evidence", "Evidence", faImage],
      ["/supervisors", "Agent sessions", faComments],
      ["/terminals", "Terminals", faClipboard],
    ],
  },
  {
    label: "Improve",
    items: [
      ["/learnings", "Learnings", faBookOpen],
      ["/analytics", "Analytics", faChartColumn],
      ["/monitors", "Monitors", faHeart],
    ],
  },
  {
    label: "Configure",
    items: [
      ["/projects", "Projects", faFolder],
      ["/policies", "Policies", faScaleBalanced],
    ],
  },
];

function SecondaryNav() {
  const location = useLocation();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const active = SECONDARY_NAV.some(({ items }) => items.some(([to]) => location.pathname.startsWith(to)));
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [location.pathname]);
  const close = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const details = event.currentTarget.closest("details");
    if (details) details.open = false;
  };
  return (
    <details ref={detailsRef} className={`more-menu ${active ? "more-menu-active" : ""}`}>
      <summary>More <span aria-hidden="true">⌄</span></summary>
      <div className="more-popover">
        {SECONDARY_NAV.map((group) => (
          <div className="more-group" key={group.label}>
            <div className="more-group-label">{group.label}</div>
            {group.items.map(([to, label, icon]) => (
              <NavLink key={to} to={to} onClick={close}>
                <FontAwesomeIcon icon={icon} />
                {label}
              </NavLink>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

// Mobile navigation mirrors the three things the director actually does:
// direct the manager, watch work, and clear items that need human attention.
function MobileNav({
  inboxCount,
  offline,
  setOffline,
}: {
  inboxCount: number;
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
  const more = SECONDARY_NAV.flatMap(({ items }) => items);
  return (
    <>
      {moreOpen && (
        <div className="mobsheet-scrim" onClick={close}>
          <div className="mobsheet" onClick={(e) => e.stopPropagation()}>
            <div className="mobsheet-grid">
              {more.map(([to, label, icon]) => (
                <NavLink key={to} to={to} className="mobsheet-item" onClick={close}>
                  <span className="mobsheet-icon"><FontAwesomeIcon icon={icon} /></span>
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
        {tab("/", "Chief", "◆", 0, true)}
        {tab("/work", "Work", "▦")}
        {tab("/inbox", "Inbox", "◎", inboxCount)}
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
        <span className="bell-icon"><FontAwesomeIcon icon={faBell} /></span>
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
  const inboxCount = decisions.length + checkpoints.length + reviewCount + tasks.filter(needsAttention).length;
  const location = useLocation();
  // Board card clicks push /tasks/:id with state.backgroundLocation set to the
  // board's location — that keeps the board mounted and rendered underneath
  // while a modal Route renders the task on top. Direct loads (deep links,
  // notifications, refresh) carry no such state, so /tasks/:id just renders
  // the standalone page as usual.
  const background = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  const managerIsRendered = (background || location).pathname === "/";
  return (
    <div className="app">
      <header className="topbar">
        <NavLink className="brand" to="/">
          <span className="brand-mark">◆</span> hive
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Chief of Staff
          </NavLink>
          <NavLink to="/work">Work</NavLink>
          <NavLink to="/inbox">
            Inbox
            {inboxCount > 0 && <span className="badge">{inboxCount}</span>}
          </NavLink>
          <SecondaryNav />
        </nav>
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
        <PushButton />
        <Bell />
        <ConnDot />
      </header>
      <MobileNav inboxCount={inboxCount} offline={offline} setOffline={setOffline} />
      <main className="content">
        <Routes location={background || location}>
          <Route path="/" element={<Chat embedded />} />
          <Route path="/work" element={<Board />} />
          <Route path="/board" element={<Navigate replace to="/work" />} />
          <Route path="/inbox" element={<Brief />} />
          <Route path="/brief" element={<Navigate replace to="/inbox" />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/evidence" element={<Evidence />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/decisions" element={<Decisions />} />
          <Route path="/review" element={<Review />} />
          <Route path="/supervisors" element={<Supervisors />} />
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
      {!managerIsRendered && <Chat />}
    </div>
  );
}
