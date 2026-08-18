import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { DiffFile, DiffResult, Evidence, Task } from "../lib/api";
import { useStore } from "../lib/store";
import { CiBadge, toast } from "../lib/ui";
import { MAX_DIFF_LINES } from "../lib/api";
import { useLightbox } from "../lib/lightbox";
import type { LightboxImage } from "../lib/lightbox";
import { relTime } from "../lib/time";
import { CheckpointList } from "./Checkpoints";
import { DecisionCard } from "./DecisionCard";
import { ReportView } from "./ReportView";
import { UnderstandingQuiz } from "./UnderstandingQuiz";

// Staleness marker: captured-at time always shows; the commit SHA (recorded
// by the CLI from the agent's worktree at capture time) compares against the
// PR's current head so a director never has to trust silently that a
// screenshot still matches HEAD (task #226).
function EvAge({ e, headSha }: { e: Evidence; headSha: string | null }) {
  const sha = typeof e.meta?.commit_sha === "string" ? (e.meta.commit_sha as string) : null;
  const stale = !!(sha && headSha && sha !== headSha);
  const title = [
    `captured ${e.ts}`,
    sha ? `commit ${sha}` : "commit unknown",
    stale ? `HEAD is now ${headSha}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`ev-age ${stale ? "ev-age-stale" : ""}`} title={title}>
      {stale && "⚠ "}
      {relTime(e.ts)}
      {sha && <span className="ev-sha">{sha.slice(0, 7)}</span>}
    </span>
  );
}

// One non-image evidence chip. Clicking a text chip expands the inline viewer
// (full width, below the strip); the ↗ opens the raw file in a tab.
function EvChip({ e, headSha }: { e: Evidence; headSha: string | null }) {
  const [open, setOpen] = useState(false);
  const label = e.caption || e.kind;
  const viewable = !!e.url && ["report", "log", "test_run"].includes(e.kind);
  const body = (
    <>
      <span className={`chip chip-kind`}>{e.kind}</span>
      <span className="rev-ev-cap">{label}</span>
      <EvAge e={e} headSha={headSha} />
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

type ReviewItem = string | { what: string; why?: string };

interface UnderstandingPacket {
  background?: string;
  essence?: string;
  walkthrough?: string[];
  participate?: string;
  check?: {
    question: string;
    options: { key: string; label: string }[];
    answer_key: string;
    explanation?: string;
  };
}

// The agent's structured self-review (latest review_summary event payload).
// Sections are all optional; strings or {what, why} objects for iffy.
interface ReviewSummary {
  done?: string[];
  iffy?: ReviewItem[];
  decisions?: string[];
  testing?: string[];
  followups?: string[];
  understanding?: UnderstandingPacket;
}

function reviewItemText(item: ReviewItem): string {
  return typeof item === "string" ? item : item.what;
}

function ReviewUnderstanding({ packet }: { packet: UnderstandingPacket }) {
  const hasContent = packet.background || packet.essence || packet.walkthrough?.length || packet.participate || packet.check;
  if (!hasContent) return null;
  return (
    <section className="review-understanding">
      <div className="understanding-eyebrow">Mental model</div>
      <div className="understanding-grid">
        {packet.background && (
          <div>
            <b>Before</b>
            <p>{packet.background}</p>
          </div>
        )}
        {packet.essence && (
          <div>
            <b>Core idea</b>
            <p>{packet.essence}</p>
          </div>
        )}
      </div>
      {packet.walkthrough?.length && (
        <div className="understanding-walkthrough">
          <b>How it works</b>
          <ol>{packet.walkthrough.map((step, i) => <li key={i}>{step}</li>)}</ol>
        </div>
      )}
      {packet.participate && (
        <div className="understanding-participate">
          <b>What this opens up</b>
          <p>{packet.participate}</p>
        </div>
      )}
    </section>
  );
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
  items?: ReviewItem[];
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

// The audit stays complete, but it is deliberately plain and subordinate to
// the recommendation shown on the card itself.
function ReviewAudit({ r }: { r: ReviewSummary }) {
  return (
    <div className="review-audit">
      <ReviewSection tone="done" icon="✓" title="Completed" items={r.done} />
      <ReviewSection tone="iffy" icon="!" title="Caveats" items={r.iffy} />
      <ReviewSection tone="decisions" icon="?" title="Judgment calls" items={r.decisions} />
      <ReviewSection tone="testing" icon="✚" title="Checks" items={r.testing} />
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
// Needs you view. Renders: title/project/summary, PR+CI status, a compact diff
// stat with an expandable inline diff, and the three primary actions
// (approve & merge, request changes, reject). `onDone` lets the parent hide or
// refresh the card after an action resolves.
export function ReviewCard({
  task,
  onDone,
}: {
  task: Task;
  onDone?: () => void;
}) {
  const { projects } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffErr, setDiffErr] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ActionMode>(null);
  const [notes, setNotes] = useState("");
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [reviewEventId, setReviewEventId] = useState<string | null>(null);
  const [reviewLoaded, setReviewLoaded] = useState(false);
  const [quizOverride, setQuizOverride] = useState<"passed" | "deferred" | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [openDecisions, setOpenDecisions] = useState<Decision[]>([]);
  const lightbox = useLightbox();

  useEffect(() => {
    let live = true;
    setDiff(null);
    setDiffErr("");
    setReview(null);
    setReviewEventId(null);
    setReviewLoaded(false);
    setQuizOverride(null);
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
              (["done", "iffy", "decisions", "testing", "followups"].some((k) => (e.payload[k] ?? []).length) ||
                (e.payload.understanding && typeof e.payload.understanding === "object"))
          );
        if (ev) {
          setReview(ev.payload as ReviewSummary);
          setReviewEventId(ev.id);
        }
        setEvidence(t.evidence ?? []);
        setEvents(t.events ?? []);
        setOpenDecisions((t.decisions ?? []).filter((d: Decision) => d.status === "open"));
      })
      .catch(() => {})
      .finally(() => live && setReviewLoaded(true));
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
  // on red CI / no PR was a lie that failed on click). Scouts and no-change
  // chores have nothing to merge; accepting the report is the whole review.
  const isScout = task.kind === "scout";
  const reportOnly = isScout || (task.kind === "chore" && diff?.files.length === 0);
  const rawQuiz = review?.understanding?.check;
  const quiz = rawQuiz && Array.isArray(rawQuiz.options) && rawQuiz.options.length >= 2 ? rawQuiz : undefined;
  const recordedQuizStatus = reviewEventId && events.some(
    (event) => event.type === "understanding_quiz_passed" && event.payload.review_event_id === reviewEventId
  )
    ? "passed"
    : reviewEventId && events.some(
        (event) => event.type === "understanding_quiz_deferred" && event.payload.review_event_id === reviewEventId
      )
      ? "deferred"
      : "required";
  const quizStatus = quizOverride ?? recordedQuizStatus;
  const missingQuiz = reviewLoaded && (!quiz || !reviewEventId);
  const quizBlocked = !reviewLoaded
    ? "Loading the understanding check"
    : missingQuiz
      ? "Understanding check is missing. Ask the agent to refresh its review."
      : quizStatus === "required"
        ? "Pass the understanding check, or explicitly save it for later."
        : "";
  const deliveryBlocked = reportOnly
    ? ""
    : task.ci_status === "failing"
      ? "CI is failing — the agent has been told to iterate; unlocks when green"
      : task.ci_status === "pending"
        ? "CI is still running — wait for green"
        : !task.pr_url && !task.branch
          ? "No PR and no branch — nothing to merge"
          : "";
  const mergeBlocked = quizBlocked || deliveryBlocked;
  const caveats = review?.iffy ?? [];
  const recommendation = openDecisions.length
    ? "Make the open decision first"
    : mergeBlocked
      ? reportOnly ? "Understand before accepting" : "Wait to merge"
      : reportOnly
        ? "Accept this report"
        : "Approve and merge";
  const recommendationReason = openDecisions.length
    ? `${openDecisions.length} decision${openDecisions.length === 1 ? "" : "s"} still need your judgment.`
    : missingQuiz
      ? "This older review has no understanding check."
      : mergeBlocked ||
      (reportOnly
        ? "Hive finished the research and submitted its evidence."
        : task.ci_status === "passing"
          ? "CI passed and Hive found no blocking issue."
          : "Hive completed its review and is ready for your approval.");
  const merge = async (strategy?: "local_ff") => {
    if (busy) return;
    setBusy(true);
    setMergeErr("");
    try {
      if (reportOnly) {
        await api.transition(task.id, "verifying");
        toast("Report accepted");
      } else {
        await api.merge(task.id, strategy);
        toast(strategy ? "Merged locally → Verifying" : "Merged → Verifying");
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
  const refreshUnderstandingCheck = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.requestChanges(
        task.id,
        "Refresh the existing review_summary without changing the implementation. Preserve the review findings and add the required understanding packet and multiple-choice understanding.check, then submit the task for review again."
      );
      toast("Agent asked to add the understanding check");
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
        <div className="review-card-heading">
          <div className="review-card-meta">
            <span className="card-num" title="Task number">#{task.number}</span>
            {project && <span>{project.name}</span>}
            <span>{task.kind}</span>
          </div>
          <h3 className="review-card-title">
            <Link to={`/tasks/${task.id}`}>{task.title}</Link>
          </h3>
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

      <div className="review-recommendation">
        <span className="review-recommendation-label">Hive recommends</span>
        <strong>{recommendation}</strong>
        <p>{recommendationReason}</p>
        {caveats[0] && (
          <div className="review-caveat">
            <span>Watch</span>
            <span className="review-caveat-text">{reviewItemText(caveats[0])}</span>
            {caveats.length > 1 && <small>+{caveats.length - 1} more</small>}
          </div>
        )}
      </div>

      {quiz && reviewEventId && quizStatus === "required" && (
        <UnderstandingQuiz
          quiz={{ task_id: task.id, question: quiz.question, options: quiz.options }}
          allowDefer
          onPassed={() => setQuizOverride("passed")}
          onDeferred={() => setQuizOverride("deferred")}
        />
      )}
      {quizStatus === "passed" && <div className="understanding-quiz-status passed">Understanding confirmed. Approval unlocked.</div>}
      {quizStatus === "deferred" && <div className="understanding-quiz-status deferred">Quiz saved in Needs You. You can continue now.</div>}

      <div className="review-actions">
        <button className="btn btn-primary" onClick={() => merge()} disabled={busy || !!mergeBlocked} title={mergeBlocked}>
          {busy ? "Working…" : reportOnly ? "Accept report" : "Approve & merge"}
        </button>
        <button className="btn" onClick={() => setMode(mode === "changes" ? null : "changes")}>
          Request changes
        </button>
        <button className="btn btn-danger" onClick={() => setMode(mode === "reject" ? null : "reject")}>
          Reject
        </button>
      </div>
      {missingQuiz ? (
        <div className="review-blocked review-blocked-action">
          <button className="btn btn-mini" disabled={busy} onClick={refreshUnderstandingCheck}>
            {busy ? "Asking…" : "Have agent add it"}
          </button>
        </div>
      ) : mergeBlocked ? (
        <div className="review-blocked">{mergeBlocked}</div>
      ) : null}
      {mergeErr && (
        <div className="review-merge-error">
          Merge failed: {mergeErr}
          {task.pr_url && !mergeErr.includes("CLOSED (not merged)") && (
            <button
              className="btn"
              style={{ marginLeft: "var(--s2)" }}
              disabled={busy || !!mergeBlocked}
              title={
                mergeBlocked ||
                "Skip GitHub's PR merge (which compares against origin/main and can be a stale fork) and fast-forward local main directly onto this branch. Only succeeds if the branch is still a clean fast-forward."
              }
              onClick={() => merge("local_ff")}
            >
              Force local merge
            </button>
          )}
        </div>
      )}

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

      <details className="review-details">
        <summary>
          <span>{reportOnly ? "Explain report" : review?.understanding ? "Understand this change" : "Why Hive recommends this"}</span>
          <small>
            {reportOnly && review?.understanding
              ? `thesis · evidence · implications`
              : review?.understanding
              ? `mental model · ${evidence.length} evidence`
              : `${review?.done?.length ?? 0} completed · ${caveats.length} caveat${caveats.length === 1 ? "" : "s"} · ${evidence.length} evidence`}
          </small>
        </summary>
        <div className="review-details-body">
          {review?.understanding && <ReviewUnderstanding packet={review.understanding} />}

          <ChangesThread events={events} />

          <CheckpointList events={events} />

          {review ? <ReviewAudit r={review} /> : task.summary && <p className="review-summary">{task.summary}</p>}
          {review && task.summary && <p className="review-summary">{task.summary}</p>}

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
                  <EvAge e={e} headSha={task.head_sha} />
                </button>
              ))}
              {others.map((e) => (
                <EvChip key={e.id} e={e} headSha={task.head_sha} />
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
        </div>
      </details>
    </section>
  );
}
