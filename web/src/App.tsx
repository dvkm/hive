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
  faEye,
  faBookOpen,
  faChartColumn,
  faFolder,
  faScaleBalanced,
  faHeart,
  faRocket,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import { useStore } from "./lib/store";
import { actionableItems } from "./lib/needsYou";
import { useProjectFilter } from "./lib/projectFilter";
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
import Catchup from "./views/Catchup";
import Policies from "./views/Policies";
import Monitors from "./views/Monitors";
import Learnings from "./views/Learnings";
import Terminals from "./views/Terminals";
import Analytics from "./views/Analytics";
import Projects from "./views/Projects";
import Palette from "./views/Palette";
import Chat from "./views/Chat";
import Supervisors from "./views/Supervisors";
import Deployments from "./views/Deployments";
import { AwayBanner, AwayToggle } from "./views/Away";
import { ThemeToggle } from "./views/ThemeToggle";

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
      ["/catchup", "Catch up", faEye],
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
      ["/deployments", "Deployments", faRocket],
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

function SecondaryNav({ offline, setOffline, rail }: { offline: boolean; setOffline: (v: boolean) => void; rail?: boolean }) {
  const location = useLocation();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const active = SECONDARY_NAV.some(({ items }) => items.some(([to]) => location.pathname.startsWith(to)));
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [location.pathname]);
  useEffect(() => {
    const close = () => {
      if (detailsRef.current) detailsRef.current.open = false;
    };
    window.addEventListener("hive:palette", close);
    window.addEventListener("hive:notifications", close);
    return () => {
      window.removeEventListener("hive:palette", close);
      window.removeEventListener("hive:notifications", close);
    };
  }, []);
  const close = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const details = event.currentTarget.closest("details");
    if (details) details.open = false;
  };
  return (
    <details
      ref={detailsRef}
      className={`more-menu ${active ? "more-menu-active" : ""}`}
      onToggle={(event) => {
        if (event.currentTarget.open) window.dispatchEvent(new Event("hive:browse"));
      }}
    >
      <summary className={rail ? "rail-item" : undefined} title={rail ? "More" : undefined} aria-label={rail ? "More" : undefined}>
        {rail ? <Icon name="more" /> : <>Browse <span aria-hidden="true">⌄</span></>}
      </summary>
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
        <div className="more-system-actions">
          <PushButton />
          <button
            className={`offline-toggle ${offline ? "offline-on" : ""}`}
            onClick={() => {
              setOffline(!offline);
              if (detailsRef.current) detailsRef.current.open = false;
            }}
          >
            {offline ? "Resume Hive" : "Go offline"}
          </button>
        </div>
      </div>
    </details>
  );
}

// Stroke icons for the rail, on a 24px grid so they scale and recolor with the theme.
const ICONS: Record<string, string> = {
  home: "M3 11l9-8 9 8M5 9.5V21h14V9.5",
  board: "M3 5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM10 5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1zM17 5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1z",
  inbox: "M3 13l2.5-8h13L21 13M3 13v6h18v-6h-5l-1.5 2h-5L8 13z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  evidence: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 16l5-5 4 4 3-3 6 6M16 9h.01",
  search: "M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0zM20 20l-4-4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === "more" ? 3.2 : 1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// The left rail: the five places the director goes, the secondary pages behind
// More, search, and the live dot. Icon-only; the page title says where you are.
function Rail({ inboxCount, offline, setOffline }: { inboxCount: number; offline: boolean; setOffline: (v: boolean) => void }) {
  const items: [string, string, keyof typeof ICONS][] = [
    ["/", "Home", "home"],
    ["/work", "Work", "board"],
    ["/inbox", "Needs you", "inbox"],
    ["/feed", "Activity", "activity"],
    ["/evidence", "Evidence", "evidence"],
  ];
  return (
    <nav className="rail" aria-label="Primary">
      <NavLink className="rail-brand" to="/" aria-label="hive home">
        <svg viewBox="0 0 18 18" fill="currentColor" width="22" height="22" aria-hidden="true">
          <path d="M9.55,4.67 L7.4,8.39 L3.1,8.39 L0.95,4.67 L3.1,0.95 L7.4,0.95 Z" />
          <path d="M17.05,9 L14.9,12.72 L10.6,12.72 L8.45,9 L10.6,5.28 L14.9,5.28 Z" />
          <path d="M9.55,13.33 L7.4,17.05 L3.1,17.05 L0.95,13.33 L3.1,9.61 L7.4,9.61 Z" />
        </svg>
      </NavLink>
      {items.map(([to, label, icon]) => (
        <NavLink key={to} to={to} end={to === "/"} className="rail-item" title={label} aria-label={label}>
          <Icon name={icon} />
          {to === "/inbox" && inboxCount > 0 && <span className="badge rail-badge">{inboxCount}</span>}
        </NavLink>
      ))}
      <div className="rail-gap" />
      <SecondaryNav offline={offline} setOffline={setOffline} rail />
      <button
        className="rail-item"
        onClick={() => window.dispatchEvent(new Event("hive:palette"))}
        title="Search or jump to anything (⌘K)"
        aria-label="Search or jump to anything"
      >
        <Icon name="search" />
      </button>
      <ConnDot />
    </nav>
  );
}

// Mobile navigation keeps the home exchange, Needs you queue, work board, and
// secondary operational views within one tap.
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
            <div className="mobsheet-actions">
              <PushButton />
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
        </div>
      )}
      <nav className="mobnav">
        {tab("/", "Home", "◆", 0, true)}
        {tab("/inbox", "Needs you", "◎", inboxCount)}
        {tab("/work", "Work", "▦")}
        <button className={`mobtab ${moreOpen ? "active" : ""}`} onClick={() => setMoreOpen((v) => !v)}>
          <span className="mobtab-icon">☰</span>
          More
        </button>
      </nav>
    </>
  );
}

function ConnDot() {
  const { sse, taskSync, tasks } = useStore();
  const label = sse === "open" ? "live" : sse === "connecting" ? "connecting" : "reconnecting";
  // The board is painted from the browser cache until the first fetch lands.
  // That is normally milliseconds, so this stays quiet; when the fetch fails
  // outright the banner below the header takes over and says so loudly.
  const cached = taskSync === "loading" && tasks.length > 0;
  return (
    <span className={`conn conn-${sse}`} title={`SSE ${label}`} aria-label={`Hive is ${label}`}>
      <span className="conn-dot" />
      <span className="conn-label">{cached ? "cached" : label}</span>
    </span>
  );
}

// The refresh of the task list failed. Whatever is on screen is either a stale
// snapshot or nothing at all, so actions taken against it will be rejected.
function StaleBanner() {
  const { taskSync, tasks, retryTaskSync } = useStore();
  if (taskSync !== "failed") return null;
  return (
    <div className="stale-banner" role="alert">
      <FontAwesomeIcon icon={faTriangleExclamation} />
      <span className="away-banner-text">
        {tasks.length
          ? "This board is out of date. Hive could not load the latest tasks, so actions may be rejected."
          : "The task list did not load. This is not an empty board."}
      </span>
      <span className="muted">Retrying.</span>
      <button className="btn btn-mini" onClick={retryTaskSync}>Retry now</button>
    </div>
  );
}

// Prerequisites + update reminder, from GET /api/doctor (the same checks as
// `hive doctor`). A missing prerequisite means agents silently never spawn,
// which on a fresh install reads as "hive does nothing", so it is said here.
type DoctorReport = {
  ok: boolean;
  checks: { name: string; ok: boolean; required: boolean; detail: string; fix: string | null }[];
  update: { behind: number; head: string | null };
};
function DoctorBanner() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [dismissedHead, setDismissedHead] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      fetch("/api/doctor")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setReport(d))
        .catch(() => {});
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  if (!report) return null;
  const broken = report.checks.filter((c) => !c.ok && c.required);
  if (broken.length) {
    return (
      <div className="stale-banner" role="alert">
        <FontAwesomeIcon icon={faTriangleExclamation} />
        <span className="away-banner-text">
          Hive cannot run agents: {broken.map((c) => `${c.name} ${c.detail}`).join("; ")}.
        </span>
        <span className="muted">{broken[0].fix!.replace(/^./, (c) => c.toUpperCase())}. Run <code>hive doctor</code> for the full list.</span>
      </div>
    );
  }
  const { behind, head } = report.update;
  if (behind > 0 && dismissedHead !== head) {
    return (
      <div className="update-banner" role="status">
        <span className="away-banner-text">
          Hive is {behind} commit{behind === 1 ? "" : "s"} behind origin/main.
        </span>
        <span className="muted">Pull and restart the daemon to update.</span>
        <button className="btn btn-mini" onClick={() => setDismissedHead(head)}>Later</button>
      </div>
    );
  }
  return null;
}

// Header bell: unread count (notifications not yet delivered/seen) + a dropdown
// of recent notifications. Opening marks everything read.
export function Bell() {
  const { notifications, ackNotifications } = useStore();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const unread = notifications.filter((n) => !n.delivered_at).length;

  useEffect(() => {
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("hive:palette", close);
    window.addEventListener("hive:browse", close);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("hive:palette", close);
      window.removeEventListener("hive:browse", close);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      window.dispatchEvent(new Event("hive:notifications"));
      if (unread > 0) ackNotifications();
    }
  };

  return (
    <div className="bell-wrap" ref={wrapRef}>
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
  const { needsYou, tasks, offline, setOffline, away, setAway } = useStore();
  const projectFilter = useProjectFilter();
  // One shared definition (lib/needsYou.ts) so this badge, the landing
  // headline and the board strip always show the same number.
  const inboxCount = actionableItems(needsYou, tasks, projectFilter).length;
  // The same number in the tab title and on the installed app's icon, so a
  // backgrounded hive still says how many things are waiting. Zero clears both
  // rather than showing a "0" badge.
  useEffect(() => {
    document.title = inboxCount > 0 ? `(${inboxCount}) hive` : "hive";
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    // Unsupported outside installed PWAs on most browsers; failing is normal.
    if (inboxCount > 0) nav.setAppBadge?.(inboxCount).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [inboxCount]);
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
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Rail inboxCount={inboxCount} offline={offline} setOffline={setOffline} />
      <div className="app-main">
      <header className="topbar">
        <button
          className="command-trigger"
          onClick={() => window.dispatchEvent(new Event("hive:palette"))}
          aria-label="Search Hive or run a command"
        >
          <span>Search or jump to anything</span>
          <kbd>⌘K</kbd>
        </button>
        <ThemeToggle />
        <AwayToggle />
        <Bell />
      </header>
      <AwayBanner away={away} onResume={() => setAway(false)} />
      <StaleBanner />
      <DoctorBanner />
      <MobileNav inboxCount={inboxCount} offline={offline} setOffline={setOffline} />
      <main className="content" id="main-content">
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
          <Route path="/catchup" element={<Catchup />} />
          <Route path="/supervisors" element={<Supervisors />} />
          <Route path="/terminals" element={<Terminals />} />
          <Route path="/learnings" element={<Learnings />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/monitors" element={<Monitors />} />
          <Route path="/deployments" element={<Deployments />} />
        </Routes>
      </main>
      </div>
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
