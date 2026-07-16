import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { DiffFile, DiffResult, Evidence, Task } from "../lib/api";
import { useStore } from "../lib/store";
import { CiBadge, toast } from "../lib/ui";
import { MAX_DIFF_LINES } from "../lib/api";
import { useLightbox } from "../lib/lightbox";
import type { LightboxImage } from "../lib/lightbox";
import { CheckpointList } from "./Checkpoints";
import { DecisionCard } from "./DecisionCard";
import { ReportView } from "./ReportView";

// One non-image evidence chip. Clicking a text chip expands the inline viewer
// (full width, below the strip); the ↗ opens the raw file in a tab.
function EvChip({ e }: { e: Evidence }) {
  const [open, setOpen] = useState(false);
  const label = e.caption || e.kind;
  const viewable = !!e.url && ["report", "log", "test_run"].includes(e.kind);
  const body = (
    <>
      <span className={`chip chip-kind`}>{e.kind}</span>
      <span className="rev-ev-cap">{label}</span>
    </>
  );
  if (viewable)
    return (
      <span className="rev-ev-item">
        <button className={`rev-ev-chip ${open ? "rev-ev-open" : ""}`} title={label} onClick={() => setOpen((o) => !o)}>
          {body}
          <a className="ev-ext" href={e.url!} target="_blank" rel="noreferrer" title="Open raw file" onClick={(ev) => ev.stopPropagation()}>
            ↗
          </a>
        </button>
        {open && <ReportView url={e.url!} />}
      </span>
    );
  return e.url ? (
    <a className="rev-ev-chip" href={e.url} target="_blank" rel="noreferrer" title={label}>
      {body}
    </a>
  ) : (
    <span className="rev-ev-chip" title={label}>
      {body}
    </span>
  );
}
import type { Decision, Event } from "../lib/api";

// The request-changes exchange: the director's notes and the agent's replies,
// in order. Without this, "Request changes" fired into the void — the agent's
// response only existed in the buried timeline.
function ChangesThread({ events }: { events: Event[] }) {
  const firstReq = events.findIndex((e) => e.type === "changes_requested");
  if (firstReq === -1) return null;
  const items = events
    .slice(firstReq)
    .filter((e) => ["changes_requested", "steer", "status", "note", "ready_for_review"].includes(e.type))
    .slice(-10);
  if (!items.length) return null;
  const text = (e: Event): string => {
    if (e.type === "changes_requested") return String(e.payload?.notes ?? "");
    if (e.type === "steer") return String(e.payload?.message ?? "");
    if (e.type === "ready_for_review") return "ready for review again";
    return String(e.payload?.note ?? "");
  };
  return (
    <div className="rv-thread">
      <div className="rv-thread-head">Changes requested — the exchange</div>
      {items.map((e) => {
        const mine = e.source === "director";
        return (
          <div key={e.id} className={`rv-msg ${mine ? "rv-mine" : "rv-theirs"}`}>
            <span className="rv-who">{mine ? "you" : "agent"}</span>
            <span className="rv-text">{text(e)}</span>
          </div>
        );
      })}
    </div>
  );
}

// The agent's structured self-review (latest review_summary event payload).
// Sections are all optional; strings or {what, why} objects for iffy.
interface ReviewSummary {
  done?: string[];
  iffy?: (string | { what: string; why?: string })[];
  decisions?: string[];
  testing?: string[];
  followups?: string[];
}

function ReviewSection({
  tone,
  icon,
  title,
  items,
}: {
  tone: string;
  icon: string;
  title: string;
  items?: (string | { what: string; why?: string })[];
}) {
  if (!items?.length) return null;
  return (
    <div className={`rs-section rs-${tone}`}>
      <div className="rs-head">
        <span className="rs-icon">{icon}</span> {title}
      </div>
      <ul>
        {items.map((it, i) =>
          typeof it === "string" ? (
            <li key={i}>{it}</li>
          ) : (
            <li key={i}>
              {it.what}
              {it.why && <span className="rs-why"> — {it.why}</span>}
            </li>
          )
        )}
      </ul>
    </div>
  );
}

// Structured digest of what the agent did — the thing the director actually
// reviews. Prose summaries stay available behind a toggle in the parent.
function ReviewDigest({ r }: { r: ReviewSummary }) {
  return (
    <div className="review-digest">
      <ReviewSection tone="done" icon="✓" title="Done" items={r.done} />
      <ReviewSection tone="iffy" icon="!" title="Iffy" items={r.iffy} />
      <ReviewSection tone="decisions" icon="?" title="Decisions made" items={r.decisions} />
      <ReviewSection tone="testing" icon="✚" title="Testing" items={r.testing} />
      <ReviewSection tone="followups" icon="→" title="Follow-ups" items={r.followups} />
    </div>
  );
}

// One collapsible file in the diff viewer. Sticky header shows path + counts.
function DiffFileView({ f, wrap }: { f: DiffFile; wrap: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="diff-file">
      <button className="diff-file-head" onClick={() => setOpen((o) => !o)}>
        <span className="diff-caret">{open ? "▾" : "▸"}</span>
        <span className="diff-path">{f.path}</span>
        <span className="diff-counts">
          <span className="diff-add">+{f.additions}</span>
          <span className="diff-del">−{f.deletions}</span>
        </span>
      </button>
      {open &&
        (f.binary ? (
          <div className="diff-binary">Binary file — not shown</div>
        ) : (
          <div className={`diff-body ${wrap ? "wrap" : ""}`}>
            {f.hunks.map((h, hi) => (
              <div className="diff-hunk" key={hi}>
                <div className="diff-hunk-head">{h.header}</div>
                {h.lines.map((l, li) => (
                  <div className={`diff-line dl-${l.kind}`} key={li}>
                    <span className="dl-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                    <span className="dl-text">{l.text || " "}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

type ActionMode = null | "changes" | "reject";

// The one review surface, shared by the task page, the /review queue, and the
// morning brief. Renders: title/project/summary, PR+CI status, a compact diff
// stat with an expandable inline diff, and the three primary actions
// (approve & merge, request changes, reject). `onDone` lets the parent hide or
// refresh the card after an action resolves.
export function ReviewCard({
  task,
  onDone,
  defaultExpanded = false,
}: {
  task: Task;
  onDone?: () => void;
  defaultExpanded?: boolean;
}) {
  const { projects } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffErr, setDiffErr] = useState("");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [wrap, setWrap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ActionMode>(null);
  const [notes, setNotes] = useState("");
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [showProse, setShowProse] = useState(false);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [openDecisions, setOpenDecisions] = useState<Decision[]>([]);
  const lightbox = useLightbox();

  useEffect(() => {
    let live = true;
    setDiff(null);
    setDiffErr("");
    setReview(null);
    setShowProse(false);
    setEvidence([]);
    api
      .diff(task.id)
      .then((d) => live && setDiff(d))
      .catch((e) => live && setDiffErr((e as Error).message));
    // Latest structured self-review, if the agent submitted one.
    api
      .task(task.id)
      .then((t) => {
        if (!live) return;
        // events are ts-ascending; take the agent's LATEST self-review that
        // actually carries sections (early buggy submissions stored {note:null})
        const ev = [...(t.events ?? [])]
          .reverse()
          .find(
            (e: any) =>
              e.type === "review_summary" &&
              e.payload &&
              ["done", "iffy", "decisions", "testing", "followups"].some((k) => (e.payload[k] ?? []).length)
          );
        if (ev) setReview(ev.payload as ReviewSummary);
        setEvidence(t.evidence ?? []);
        setEvents(t.events ?? []);
        setOpenDecisions((t.decisions ?? []).filter((d: Decision) => d.status === "open"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [task.id]);

  const stat = diff?.files.reduce(
    (a, f) => ({ files: a.files + 1, add: a.add + f.additions, del: a.del + f.deletions }),
    { files: 0, add: 0, del: 0 }
  );

  const [mergeErr, setMergeErr] = useState<string>("");
  // The CTA must not promise what the state can't deliver ("Approve & merge"
  // on red CI / no PR was a lie that failed on click). Scouts have nothing to
  // merge — accepting the report is the whole review.
  const isScout = task.kind === "scout";
  const mergeBlocked = !isScout
    ? task.ci_status === "failing"
      ? "CI is failing — the agent has been told to iterate; unlocks when green"
      : task.ci_status === "pending"
        ? "CI is still running — wait for green"
        : !task.pr_url && !task.branch
          ? "No PR and no branch — nothing to merge"
          : ""
    : "";
  const merge = async () => {
    if (busy) return;
    setBusy(true);
    setMergeErr("");
    try {
      if (isScout) {
        await api.transition(task.id, "verifying");
        toast("Report accepted");
      } else {
        await api.merge(task.id);
        toast("Merged → Verifying");
      }
      onDone?.();
    } catch (e) {
      const msg = (e as Error).message;
      // Keep the reason ON the card — a vanishing toast made failed merges
      // read as "the button silently didn't work". But a conflict bounce
      // moves the task back to in_progress, which unmounts this card before
      // the error renders — so the toast must carry the reason too.
      setMergeErr(msg);
      toast(`Not merged — ${msg}`);
    } finally {
      setBusy(false);
    }
  };
  const requestChanges = async () => {
    if (!notes.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.requestChanges(task.id, notes);
      toast(r.delivered ? "Changes requested — sent to agent" : "Changes requested (agent offline; recorded)");
      setNotes("");
      setMode(null);
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!notes.trim() || busy) return;
    setBusy(true);
    try {
      await api.transition(task.id, "cancelled", notes);
      toast("Rejected — task cancelled");
      setNotes("");
      setMode(null);
      onDone?.();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="review-card">
      <div className="review-card-head">
        <div className="review-card-title">
          <span className="card-num" title="Task number">#{task.number}</span>
          <Link to={`/tasks/${task.id}`}>{task.title}</Link>
          {project && <span className="chip">{project.name}</span>}
          <span className={`chip chip-kind chip-${task.kind}`}>{task.kind}</span>
        </div>
        <div className="review-status">
          {task.pr_url ? (
            <a className="pr" href={task.pr_url} target="_blank" rel="noreferrer" title={`Pull request linked to #${task.number}`}>
              PR ↔ #{task.number} {"↗"}
            </a>
          ) : (
            <span className="muted mono-sm">branch {task.branch || "?"}</span>
          )}
          <CiBadge status={task.ci_status} />
        </div>
      </div>

      {/* Open decision cards are answerable RIGHT HERE — radios, not text. */}
      {openDecisions.map((d) => (
        <DecisionCard key={d.id} d={d} onDone={() => setOpenDecisions((ds) => ds.filter((x) => x.id !== d.id))} />
      ))}

      <ChangesThread events={events} />

      <CheckpointList events={events} />

      {review ? (
        <>
          <ReviewDigest r={review} />
          {task.summary && (
            <button className="rs-prose-toggle" onClick={() => setShowProse((x) => !x)}>
              {showProse ? "hide" : "show"} full summary
            </button>
          )}
          {showProse && task.summary && <p className="review-summary">{task.summary}</p>}
        </>
      ) : (
        task.summary && <p className="review-summary">{task.summary}</p>
      )}

      {evidence.length > 0 &&
        (() => {
          // Screenshots as lightbox thumbnails; everything else (test runs,
          // logs, reports, links) as compact chips. The proof rides with the
          // review instead of a click away on the task page.
          const imgs = evidence.filter((e) => e.kind === "screenshot" && e.url);
          const lb: LightboxImage[] = imgs.map((e) => ({
            url: e.url!,
            caption: e.caption,
            taskId: task.id,
            taskTitle: task.title,
            ts: e.ts,
          }));
          const others = evidence.filter((e) => !(e.kind === "screenshot" && e.url));
          return (
            <div className="review-evidence">
              {imgs.map((e, i) => (
                <button key={e.id} className="rev-thumb" title={e.caption || "screenshot"} onClick={() => lightbox.open(lb, i)}>
                  <img src={e.url!} alt={e.caption || "screenshot"} />
                </button>
              ))}
              {others.map((e) => (
                <EvChip key={e.id} e={e} />
              ))}
            </div>
          );
        })()}

      <div className="review-diffstat">
        {diffErr ? (
          <span className="diff-err">Could not load diff: {diffErr}</span>
        ) : !diff ? (
          <span className="muted">Loading diff{"…"}</span>
        ) : stat && stat.files > 0 ? (
          <button className="diffstat-toggle" onClick={() => setExpanded((x) => !x)}>
            <span className="diff-caret">{expanded ? "▾" : "▸"}</span>
            {stat.files} file{stat.files === 1 ? "" : "s"}{" "}
            <span className="diff-add">+{stat.add}</span> <span className="diff-del">{"−"}{stat.del}</span>
          </button>
        ) : (
          <span className="muted">No changes to show.</span>
        )}
        {expanded && diff && diff.files.length > 0 && (
          <label className="wrap-toggle">
            <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> wrap
          </label>
        )}
      </div>

      {expanded && diff && (
        <div className="diff-viewer">
          {diff.files.map((f) => (
            <DiffFileView key={f.path} f={f} wrap={wrap} />
          ))}
          {diff.truncated && (
            <div className="diff-trunc">Diff truncated (over {MAX_DIFF_LINES.toLocaleString()} lines). View the full diff in the PR.</div>
          )}
        </div>
      )}

      <div className="review-actions">
        <button className="btn btn-primary" onClick={merge} disabled={busy || !!mergeBlocked} title={mergeBlocked}>
          {busy ? "Working…" : isScout ? "Accept report" : "Approve & merge"}
        </button>
        <button className="btn" onClick={() => setMode(mode === "changes" ? null : "changes")}>
          Request changes
        </button>
        <button className="btn btn-danger" onClick={() => setMode(mode === "reject" ? null : "reject")}>
          Reject
        </button>
      </div>
      {mergeBlocked && <div className="review-blocked">{mergeBlocked}</div>}
      {mergeErr && <div className="review-merge-error">Merge failed: {mergeErr}</div>}

      {mode && (
        <div className="review-notes">
          <textarea
            placeholder={
              mode === "changes"
                ? "What needs to change before merge? (sent to the agent)"
                : "Why reject this? (recorded as the cancellation reason)"
            }
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            autoFocus
          />
          <button
            className={`btn ${mode === "reject" ? "btn-danger" : "btn-primary"}`}
            onClick={mode === "changes" ? requestChanges : reject}
            disabled={!notes.trim() || busy}
          >
            {mode === "changes" ? "Send & return to In Progress" : "Reject & cancel task"}
          </button>
        </div>
      )}
    </section>
  );
}
