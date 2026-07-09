import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import type { FeedEvent } from "../lib/api";
import { useStore } from "../lib/store";
import { useLightbox } from "../lib/lightbox";
import type { LightboxImage } from "../lib/lightbox";
import { eventText, eventCategory, FEED_CATEGORIES } from "../lib/eventText";
import type { FeedCategory } from "../lib/eventText";

const LAST_SEEN_KEY = "hive.feed.lastSeen";
const ALL_CATS = new Set<FeedCategory>(FEED_CATEGORIES.map((c) => c.key));

// Which time bucket a timestamp falls into. Rows are already newest-first, so
// buckets come out in order as we walk the list.
function bucketLabel(ts: string, now: number): string {
  const t = new Date(ts).getTime();
  if (now - t < 3_600_000) return "Last hour";
  const d = new Date(ts);
  const nd = new Date(now);
  const sameDay = d.toDateString() === nd.toDateString();
  if (sameDay) return "Earlier today";
  const yst = new Date(now - 86_400_000);
  if (d.toDateString() === yst.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function clockTime(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function Feed() {
  const { feedEvents, tasks, projects, evidenceMeta } = useStore();
  const location = useLocation();
  const lightbox = useLightbox();

  const [project, setProject] = useState(""); // "" = all projects
  const [cats, setCats] = useState<Set<FeedCategory>>(new Set(ALL_CATS));
  const [serverRows, setServerRows] = useState<FeedEvent[]>([]);

  // The last-looked marker: read the stored value now, then stamp this visit so
  // the divider next time sits at the moment we opened the feed.
  const marker = useMemo(() => localStorage.getItem(LAST_SEEN_KEY), []);
  useEffect(() => {
    localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
  }, []);

  // types csv sent to the server only when a subset is selected — an empty/full
  // selection means "everything" (including custom event types the toggles miss).
  const allSelected = cats.size === ALL_CATS.size;
  const typesCsv = allSelected ? undefined : [...cats].join(",");

  useEffect(() => {
    let live = true;
    api
      .feed({ project: project || undefined, types: typesCsv, limit: 300 })
      .then((r) => live && setServerRows(r.events))
      .catch(() => live && setServerRows([]));
    return () => {
      live = false;
    };
  }, [project, typesCsv]);

  // Live rows: SSE events not yet in the server page, enriched from the store and
  // passed through the same filters. Enrichment is cheap and reactive, so a task
  // that arrives a beat after its event still resolves on the next render.
  const seen = useRef<Set<string>>(new Set());
  seen.current = new Set(serverRows.map((r) => r.id));
  const liveRows: FeedEvent[] = feedEvents
    .filter((e) => !seen.current.has(e.id) && !seen.current.has(e.id.split(":")[0]))
    .filter((e) => allSelected || cats.has(eventCategory(e.type)))
    .map((e): FeedEvent | null => {
      // Standalone monitor incidents (no task): enrich from projects directly.
      if (e.type === "incident") {
        const pid = String(e.payload.project_id || "");
        if (project && pid !== project) return null;
        const p = projects.find((x) => x.id === pid);
        return {
          ...e,
          task_id: null,
          task_number: null,
          task_title: null,
          task_kind: null,
          project_id: pid,
          project_name: p?.name ?? "",
          evidence_url: null,
          evidence_kind: null,
        };
      }
      const t = tasks.find((x) => x.id === e.task_id);
      if (!t) return null;
      if (project && t.project_id !== project) return null;
      const p = projects.find((x) => x.id === t.project_id);
      const ev = e.payload.evidence_id ? evidenceMeta[String(e.payload.evidence_id)] : undefined;
      return {
        ...e,
        task_number: t.number,
        task_title: t.title,
        task_kind: t.kind,
        project_id: t.project_id,
        project_name: p?.name ?? "",
        evidence_url: ev?.url ?? null,
        evidence_kind: (ev?.kind as FeedEvent["evidence_kind"]) ?? null,
      };
    })
    .filter((r): r is FeedEvent => r !== null);

  const rows = [...liveRows, ...serverRows];

  // Digest strip — counts over the currently-visible window.
  const digest = useMemo(() => {
    let done = 0, failed = 0, decisions = 0, incidents = 0;
    for (const r of rows) {
      if (r.type === "state_change" && r.payload.to === "done") done++;
      else if (r.type === "state_change" && r.payload.to === "failed") failed++;
      if (r.type === "needs-decision") decisions++;
      if (eventCategory(r.type) === "incident") incidents++;
    }
    return { done, failed, decisions, incidents };
  }, [rows]);

  const only = (c: FeedCategory) => setCats(new Set([c]));
  const toggle = (c: FeedCategory) =>
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      // never let the toggles collapse to nothing — reset to all
      return next.size === 0 ? new Set(ALL_CATS) : next;
    });

  // Index of the first row at/older than the marker: the divider goes above it.
  const markerIdx =
    marker != null ? rows.findIndex((r) => r.ts <= marker) : -1;

  // Clicking a feed thumbnail opens the lightbox over that task's screenshots
  // among the currently-visible rows, positioned at the clicked one.
  const openThumb = (row: FeedEvent) => {
    const shots = rows.filter(
      (r) => r.task_id && r.task_id === row.task_id && r.evidence_kind === "screenshot" && r.evidence_url
    );
    const imgs: LightboxImage[] = shots.map((r) => ({
      url: r.evidence_url!,
      caption: String(r.payload.caption || r.task_title || ""),
      taskId: r.task_id,
      taskTitle: r.task_title,
      ts: r.ts,
    }));
    lightbox.open(imgs, shots.findIndex((r) => r.id === row.id));
  };

  const now = Date.now();
  let lastBucket = "";

  return (
    <div className="feed">
      <div className="feed-digest">
        <Stat n={digest.done} label="done" tone="green" onClick={() => only("state")} />
        <Stat n={digest.failed} label="failed" tone="red" onClick={() => only("state")} />
        <Stat n={digest.decisions} label={digest.decisions === 1 ? "decision" : "decisions"} tone="amber" onClick={() => only("decision")} />
        <Stat n={digest.incidents} label={digest.incidents === 1 ? "incident" : "incidents"} tone="red" onClick={() => only("incident")} />
        <div className="feed-filters">
          <select className="feed-proj" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {FEED_CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`feed-toggle ${cats.has(c.key) ? "on" : ""}`}
              onClick={() => toggle(c.key)}
              title={`Toggle ${c.label}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 && (
        <div className="empty">
          <div className="empty-big">Nothing to catch up on</div>
          <div className="muted">No activity matches these filters.</div>
        </div>
      )}

      <div className="feed-list">
        {rows.map((r, i) => {
          const bucket = bucketLabel(r.ts, now);
          const showBucket = bucket !== lastBucket;
          lastBucket = bucket;
          return (
            <div key={r.id}>
              {showBucket && <div className="feed-bucket">{bucket}</div>}
              {i === markerIdx && markerIdx > 0 && (
                <div className="feed-lastseen"><span>last seen</span></div>
              )}
              <FeedRow r={r} location={location} onThumb={() => openThumb(r)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ n, label, tone, onClick }: { n: number; label: string; tone: string; onClick: () => void }) {
  return (
    <button className={`digest-stat ${n > 0 ? `tone-${tone}` : "tone-zero"}`} onClick={onClick} title={`Filter: ${label}`}>
      <span className="digest-n">{n}</span> {label}
    </button>
  );
}

function FeedRow({
  r,
  location,
  onThumb,
}: {
  r: FeedEvent;
  location: ReturnType<typeof useLocation>;
  onThumb: () => void;
}) {
  const cat = eventCategory(r.type);

  // Standalone monitor incident: no task to link to; show the monitor instead.
  if (r.type === "incident") {
    return (
      <div className="feed-row cat-incident">
        <span className="feed-time" title={r.ts}>{clockTime(r.ts)}</span>
        <div className="feed-main">
          <div className="feed-line">
            {r.project_name && <span className="chip chip-kind">{r.project_name}</span>}
            <span className="feed-monitor">monitor: {String(r.payload.monitor || "")}</span>
            <span className="feed-text">{eventText(r)}</span>
          </div>
        </div>
      </div>
    );
  }

  const isScreenshot = r.evidence_kind === "screenshot" && r.evidence_url;
  return (
    <div className={`feed-row cat-${cat}`}>
      <span className="feed-time" title={r.ts}>{clockTime(r.ts)}</span>
      <div className="feed-main">
        <div className="feed-line">
          <span className={`chip chip-kind chip-${r.task_kind}`}>{r.project_name}</span>
          {r.task_number != null && <span className="feed-num" title="Task number">#{r.task_number}</span>}
          <Link className="feed-task" to={`/tasks/${r.task_id}`} state={{ backgroundLocation: location }}>
            {r.task_title}
          </Link>
          <span className="feed-text">{eventText(r)}</span>
        </div>
        {isScreenshot && (
          <button className="feed-thumb" onClick={onThumb} title="Open">
            <img src={r.evidence_url!} alt={String(r.payload.caption || "screenshot")} />
          </button>
        )}
      </div>
    </div>
  );
}
