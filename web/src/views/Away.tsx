import { useState } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMoon } from "@fortawesome/free-solid-svg-icons";
import type { Away, HeldPush } from "../lib/api";
import { useStore } from "../lib/store";
import { relTime } from "../lib/time";

const DISMISSED_KEY = "hive.away.summaryDismissed";

// Topbar switch. On = hive holds the low-urgency phone pushes and sends one
// summary when away mode lifts.
export function AwayToggle() {
  const { away, setAway } = useStore();
  return (
    <button
      className={`offline-toggle away-toggle ${away.active ? "away-on" : ""}`}
      aria-pressed={away.active}
      title={away.active ? "Away: notifications are being held" : "Away mode: hold notifications, get one summary later"}
      onClick={() => setAway(!away.on)}
    >
      <FontAwesomeIcon icon={faMoon} /> {away.active ? "Away" : "away"}
    </button>
  );
}

// "until 08:00" — only when a schedule is what makes hive away right now. A
// manual switch has no end time, so it says nothing about one.
function untilText(away: Away): string {
  return !away.on && away.schedule ? ` until ${away.schedule.end}` : "";
}

// Always on screen while away mode is active, so the held notifications are
// never a surprise.
export function AwayBanner({ away, onResume }: { away: Away; onResume: () => void }) {
  if (!away.active) return null;
  return (
    <div className="away-banner" role="status">
      <FontAwesomeIcon icon={faMoon} />
      <span className="away-banner-text">
        Away{untilText(away)}. Holding notifications{away.held > 0 ? `: ${away.held} so far` : ""}.
      </span>
      {away.held > 0 && <Link to="/inbox">See what's held</Link>}
      <button className="btn btn-mini" onClick={onResume}>
        Resume notifications
      </button>
    </div>
  );
}

function HeldList({ items }: { items: HeldPush[] }) {
  return (
    <ul className="away-held-list">
      {items.map((item, i) => (
        <li key={`${item.at}-${i}`}>
          <Link to={item.url}>{item.title}</Link>
          {item.body && <span className="muted">{item.body}</span>}
          <span className="muted" title={item.at}>{relTime(item.at)}</span>
        </li>
      ))}
    </ul>
  );
}

// The view the wake-up push links to. While away it shows what is being held;
// after away mode lifts it shows what the summary push covered, until dismissed.
export function HeldSummary() {
  // Optional chaining because the Brief's own tests mount it against partial
  // store stubs.
  const { away } = useStore();
  const flush = away?.last_flush ?? null;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY));
  const held = away?.items ?? [];

  if (away?.active && held.length > 0)
    return (
      <section className="brief-section away-summary">
        <h2 className="brief-h">
          Held while away <span className="brief-count">{held.length}</span>
        </h2>
        <HeldList items={held} />
      </section>
    );

  if (!flush || !flush.items.length || dismissed === flush.at) return null;
  return (
    <section className="brief-section away-summary">
      <h2 className="brief-h">
        While you were away <span className="brief-count">{flush.items.length}</span>
      </h2>
      <HeldList items={flush.items} />
      <button
        className="btn btn-mini"
        onClick={() => {
          localStorage.setItem(DISMISSED_KEY, flush.at);
          setDismissed(flush.at);
        }}
      >
        Dismiss
      </button>
    </section>
  );
}
