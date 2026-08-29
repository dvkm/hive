import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { BranchCheck, DiffFile, DiffResult, Evidence, ReviewItem, ReviewSummary, Task, UnderstandingPacket, VerificationItem } from "../lib/api";
import { useStore } from "../lib/store";
import { CiBadge, SidecarChip, toast } from "../lib/ui";
import { MAX_DIFF_LINES } from "../lib/api";
import { useLightbox } from "../lib/lightbox";
import type { LightboxImage } from "../lib/lightbox";
import { relTime } from "../lib/time";
import { eventText, isFailureEvent } from "../lib/eventText";
import { CheckpointList } from "./Checkpoints";
import { DecisionCard } from "./DecisionCard";
import { ReportView } from "./ReportView";
import { UnderstandingQuiz } from "./UnderstandingQuiz";
import { PrReference, TaskRef, TaskReference, prLabel, taskLabel } from "../lib/references";

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

// The task's verification contract, as a checklist (HIVE-403). The director
// should not have to infer from a pile of evidence chips whether the commands
// the agent promised to run actually ran: one line per command, its evidence
// linked, the unproven ones marked. The server resolves satisfied/missing with
// the very same checker the merge gate uses, so this can't drift from it.
export function VerificationChecklist({ items, evidence }: { items: VerificationItem[]; evidence: Evidence[] }) {
  if (!items.length) return null;
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const missing = items.filter((i) => !i.satisfied).length;
  return (
    <div className="review-verify">
      <div className="review-verify-head">
        <span>Verification contract</span>
        <small>{missing ? `${missing} of ${items.length} unproven` : `all ${items.length} verified`}</small>
      </div>
      <ul>
        {items.map((i) => {
          const e = i.evidence_id ? byId.get(i.evidence_id) : undefined;
          return (
            <li key={i.name} className={i.satisfied ? "verify-ok" : "verify-missing"}>
              <span className="verify-mark">{i.satisfied ? "✓" : "✗"}</span>
              <span className="verify-name">{i.name}</span>
              <code className="verify-cmd" title={i.cmd}>{i.cmd}</code>
              {i.satisfied ? (
                e?.url ? (
                  <a className="verify-link" href={e.url} target="_blank" rel="noreferrer">
                    {e.caption || "evidence"}
                  </a>
                ) : (
                  <span className="verify-link muted">evidence attached</span>
                )
              ) : (
                <span className="verify-link">no evidence</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function EvidenceStrip({ evidence, task, limit }: { evidence: Evidence[]; task: Pick<Task, "id" | "title" | "head_sha">; limit?: number }) {
  const lightbox = useLightbox();
  if (!evidence.length) return null;
  const ordered = [...evidence].sort((a, b) => a.ts.localeCompare(b.ts));
  const visible = limit ? ordered.slice(-limit) : ordered;
  const images = visible.filter((e) => e.kind === "screenshot" && e.url);
  const lightboxImages: LightboxImage[] = images.map((e) => ({
    url: e.url!,
    caption: e.caption,
    taskId: task.id,
    taskTitle: task.title,
    ts: e.ts,
  }));
  return (
    <div className="review-evidence brief-evidence">
      {visible.map((e) => e.kind === "screenshot" && e.url ? (
        <button key={e.id} className="rev-thumb" title={e.caption || "screenshot"} onClick={() => lightbox.open(lightboxImages, images.findIndex((image) => image.id === e.id))}>
          <img src={e.url} alt={e.caption || "screenshot"} />
          <EvAge e={e} headSha={task.head_sha} />
        </button>
      ) : <EvChip key={e.id} e={e} headSha={task.head_sha} />)}
      {limit && evidence.length > limit && <Link className="brief-evidence-more" to={`/tasks/${task.id}`}>+{evidence.length - limit} more</Link>}
    </div>
  );
}
import type { Decision, Event } from "../lib/api";

// The request-changes exchange: the director's notes and the agent's replies,
// in order. Without this, "Request changes" fired into the void — the agent's
// response only existed in the buried timeline.
// The pre-review's risks and questions, after the per-risk check re-read the
// real code for this head (HIVE-406/407). Confirmed risks are red, refuted ones
// green, and a question only the human can answer stays amber — so the director
// reads a short verdict list instead of a wall of maybes. Verdicts recorded for
// an older head are ignored: they say nothing about what is about to merge.
export function RiskVerdicts({ events, headSha }: { events: Event[]; headSha: string | null }) {
  const review = [...events].reverse().find((e) => e.type === "auto_review" && !e.payload.skipped);
  const verdictEvent = headSha
    ? [...events].reverse().find((e) => e.type === "risk_verdicts" && e.payload.reviewed_head_sha === headSha)
    : undefined;
  if (!review || !verdictEvent) return null;
  const risks = (verdictEvent.payload.verdicts ?? []) as { risk: string; verdict: string; why?: string; evidence_path?: string }[];
  const questions = (verdictEvent.payload.question_verdicts ?? []) as { question: string; answerable: string; answer?: string }[];
  const unverified = Number(verdictEvent.payload.unverified) || 0;
  if (!risks.length && !questions.length && !unverified) return null;
  // "Still open" is what the director must act on: a risk the check confirmed,
  // a question only they can answer, or an item the check could not reach.
  const noted = risks.length + questions.length;
  const open =
    risks.filter((r) => r.verdict === "confirmed").length + questions.filter((q) => q.answerable === "human").length + unverified;
  return (
    <div className="risk-verdicts">
      <span className="risk-verdicts-label">
        Pre-review {review.payload.verdict === "caution" ? "flagged" : "noted"} {noted} thing{noted === 1 ? "" : "s"} — {open || "none"}{" "}
        still open
      </span>
      <ul>
        {risks.map((r, i) => (
          <li key={`r${i}`} className={r.verdict === "confirmed" ? "rv-confirmed" : "rv-refuted"}>
            <span className="rv-chip">{r.verdict === "confirmed" ? "confirmed" : "refuted"}</span>
            <span className="rv-text" title={[r.why, r.evidence_path].filter(Boolean).join(" · ")}>
              {r.risk}
            </span>
          </li>
        ))}
        {questions.map((q, i) => (
          <li key={`q${i}`} className={q.answerable === "human" ? "rv-human" : "rv-refuted"}>
            <span className="rv-chip">{q.answerable === "human" ? "you answer" : "answered"}</span>
            <span className="rv-text" title={q.answer ?? ""}>
              {q.question}
            </span>
          </li>
        ))}
        {unverified > 0 && (
          <li className="rv-human">
            <span className="rv-chip">unchecked</span>
            <span className="rv-text">{unverified} could not be checked</span>
          </li>
        )}
      </ul>
    </div>
  );
}

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

function reviewItemText(item: ReviewItem): string {
  return typeof item === "string" ? item : item.what;
}

export type ExplainState =
  | { status: "ready"; url: string; stale: boolean }
  | { status: "generating" }
  | null;

// #1556: the generated page IS the explanation — diagrams, mockups, data flow,
// quiz — so it belongs in the card, not behind an evidence link. Sandboxed with
// allow-scripts only: the page is self-contained, and withholding same-origin
// keeps it out of the app's cookies and storage.
function ExplainEmbed({ explain }: { explain: ExplainState }) {
  // Phones get a button, not a squeezed iframe (ADHD-first: one tap, full screen).
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 720);
  const [tall, setTall] = useState(false);
  if (!explain) return null;
  if (explain.status === "generating")
    return (
      <div className="explain-embed explain-embed-pending">
        <b>Visual explanation</b>
        <p>Hive is drawing it for this commit. It shows up here when it is ready.</p>
      </div>
    );
  return (
    <div className="explain-embed">
      <div className="explain-embed-head">
        <button className="explain-embed-toggle" onClick={() => setOpen((o) => !o)}>
          <span className="diff-caret">{open ? "\u25be" : "\u25b8"}</span>
          {open ? "Visual explanation" : "Open visual explanation"}
        </button>
        {explain.stale && (
          <span className="explain-embed-stale" title="This page was written for an earlier commit on this PR.">
            {"\u26a0"} older commit
          </span>
        )}
        <a className="explain-embed-ext" href={explain.url} target="_blank" rel="noreferrer">
          New tab {"\u2197"}
        </a>
      </div>
      {open && (
        <>
          <iframe
            className={`explain-embed-frame ${tall ? "explain-embed-tall" : ""}`}
            src={explain.url}
            sandbox="allow-scripts"
            title="Visual explanation of this change"
            loading="lazy"
          />
          <button className="explain-embed-expand" onClick={() => setTall((t) => !t)}>
            {tall ? "Shrink" : "Expand"}
          </button>
        </>
      )}
    </div>
  );
}

export function ReviewUnderstanding({ packet, report = false, caveats = [], explain = null }: { packet: UnderstandingPacket; report?: boolean; caveats?: ReviewItem[]; explain?: ExplainState }) {
  const hasContent = packet.background || packet.scope || packet.essence || packet.walkthrough?.length || packet.affected_areas?.length || packet.risk_assessment || packet.participate;
  if (!hasContent && !explain) return null;

  if (report) {
    const risk = packet.risk_assessment || caveats.map(reviewItemText).join(" ");
    return (
      <section className="review-understanding report-explanation">
        <div className="understanding-eyebrow">Report explained</div>
        {packet.background && (
          <div>
            <b>Background</b>
            <p>{packet.background}</p>
          </div>
        )}
        {packet.essence && (
          <div className="report-explanation-headline">
            <b>Key finding</b>
            <p>{packet.essence}</p>
          </div>
        )}
        {packet.scope && (
          <div>
            <b>Scope</b>
            <p>{packet.scope}</p>
          </div>
        )}
        {packet.walkthrough?.length && (
          <div className="understanding-walkthrough">
            <b>Evidence chain</b>
            <ol>{packet.walkthrough.map((step, i) => <li key={i}>{step}</li>)}</ol>
          </div>
        )}
        {packet.affected_areas?.length && (
          <div className="understanding-affected">
            <b>Affected areas</b>
            <ul>{packet.affected_areas.map((area, i) => <li key={i}>{area}</li>)}</ul>
          </div>
        )}
        {risk && (
          <div className="understanding-risk">
            <b>Risk assessment</b>
            <p>{risk}</p>
          </div>
        )}
        {packet.participate && (
          <div className="understanding-participate">
            <b>What to do with this</b>
            <p>{packet.participate}</p>
          </div>
        )}
        <ExplainEmbed explain={explain} />
      </section>
    );
  }

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
      <ExplainEmbed explain={explain} />
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
export function ReviewAudit({ r }: { r: ReviewSummary }) {
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

// Approved-to-land, then understood. The mark was made BEFORE the director knew
// what the change does, so the queue stops and asks rather than merging on the
// next sweep (HIVE-421). "Land now" re-marks it, which puts the approval after
// the quiz again; "Unmark" takes it out of the queue. Either tap sets landActed,
// so the hold clears on the tap itself, because the task prop and the events
// still carry the pre-tap state until the refetch lands.
export function isLandHeld(o: {
  landActed: boolean;
  landQueuedAt?: string | null;
  quizStatus: string;
  passedThisSession: boolean;
  events: Event[];
  reviewEventId: string | null;
}): boolean {
  if (o.landActed || !o.landQueuedAt || o.quizStatus !== "passed") return false;
  if (o.passedThisSession) return true;
  const lastIndexOf = (match: (e: Event) => boolean) => {
    for (let i = o.events.length - 1; i >= 0; i--) if (match(o.events[i])) return i;
    return -1;
  };
  return (
    lastIndexOf((e) => e.type === "understanding_quiz_passed" && e.payload.review_event_id === o.reviewEventId) >
    lastIndexOf((e) => e.type === "land_queued")
  );
}

// The one review surface, shared by the task page, the /review queue, and the
// Needs you view. Renders: title/project/summary, PR+CI status, a compact diff
// stat with an expandable inline diff, and the three primary actions
// (approve & merge, request changes, reject). `onDone` lets the parent hide or
// refresh the card after an action resolves.
export function ReviewCard({
  task,
  onDone,
  surface,
}: {
  task: Task;
  onDone?: () => void;
  surface?: "focus";
}) {
  const { projects, tasks = [], quizzes: understandingQuizzes } = useStore();
  const project = projects.find((p) => p.id === task.project_id);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffErr, setDiffErr] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [busy, setBusy] = useState(false);
  // Tapping Land now / Unmark settles the question; the task prop still carries
  // the old land_queued_at until the parent refetches, so hide the prompt here.
  const [landActed, setLandActed] = useState(false);
  const [mode, setMode] = useState<ActionMode>(null);
  const [notes, setNotes] = useState("");
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const [reviewEventId, setReviewEventId] = useState<string | null>(null);
  const [reviewLoaded, setReviewLoaded] = useState(false);
  const [quizOverride, setQuizOverride] = useState<"passed" | "deferred" | null>(null);
  const [mergeErr, setMergeErr] = useState("");
  const [branchCheck, setBranchCheck] = useState<BranchCheck | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [verification, setVerification] = useState<VerificationItem[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [openDecisions, setOpenDecisions] = useState<Decision[]>([]);

  useEffect(() => {
    let live = true;
    setDiff(null);
    setDiffErr("");
    setReview(null);
    setReviewEventId(null);
    setReviewLoaded(false);
    setQuizOverride(null);
    setEvidence([]);
    setVerification([]);
    setBranchCheck(null);
    // Same-route navigation between tasks re-renders this component in place
    // (no remount) — without this, a "Request changes" editor left open on
    // the previous task keeps rendering, notes and all, against the new one.
    setMode(null);
    setNotes("");
    api
      .diff(task.id)
      .then((d) => live && setDiff(d))
      .catch((e) => live && setDiffErr((e as Error).message));
    // Recomputed live on every review, not trusted from the agent's evidence
    // prose (task #1000): is the declared dependency actually merged, and
    // does this branch share history with another currently open task's.
    api
      .branchCheck(task.id)
      .then((b) => live && setBranchCheck(b))
      .catch(() => {});
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
        setVerification(t.verification ?? []);
        setEvents(t.events ?? []);
        setOpenDecisions((t.decisions ?? []).filter((d: Decision) => d.status === "open"));
        const mergeReason = t.health?.status === "stuck" && /^merge (?:failed|blocked): /.test(t.health.reason ?? "")
          ? t.health!.reason!.replace(/^merge (?:failed|blocked): /, "")
          : "";
        setMergeErr(mergeReason);
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

  // The CTA must not promise what the state can't deliver ("Approve & merge"
  // on red CI / no PR was a lie that failed on click). Scouts and no-change
  // chores have nothing to merge; accepting the report is the whole review.
  const isScout = task.kind === "scout";
  const reportOnly = isScout || (task.kind === "chore" && diff?.files.length === 0);
  const rawQuiz = review?.understanding?.checks?.[0] ?? review?.understanding?.check;
  const listedQuiz = understandingQuizzes.find((item) => item.task_id === task.id);
  const quiz = listedQuiz ?? (rawQuiz && Array.isArray(rawQuiz.options) && rawQuiz.options.length >= 2 ? rawQuiz : undefined);
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
  // Mechanical changes are not judgment-class (hive-1559): no quiz is minted,
  // and its absence blocks nothing. Undefined (older server) keeps the old gate.
  const quizRequired = branchCheck?.understanding_required !== false;
  const missingQuiz = reviewLoaded && (!quiz || !reviewEventId);
  const quizBlocked = !quizRequired
    ? ""
    : !reviewLoaded
    ? "Loading the understanding check"
    : missingQuiz
      ? task.never_dispatched
        ? "No understanding check, and this tracking-only task has never been dispatched to an agent to add one."
        : "Understanding check is missing. Ask the agent to refresh its review."
      : quizStatus === "required"
        ? "Pass the understanding check, or explicitly save it for later."
        : "";
  // #1249: hive writes one page per PR head explaining the change. It is stored
  // as ordinary evidence, so the newest one is the current one. #1556: a page
  // written for an older head is shown but labelled, never passed off as current.
  const explainPages = [...evidence].reverse().filter((e) => e.kind === "explanation" && e.url);
  // Same match rule as the server's explanationFor(): a page counts as current
  // only when its recorded commit is the PR's head.
  const explainCurrent = task.head_sha ? explainPages.find((e) => e.meta?.commit_sha === task.head_sha) : explainPages[0];
  const explainPage = explainCurrent ?? explainPages[0];
  const explainStale = !!explainPage && !explainCurrent;
  const lastExplainEvent = [...events].reverse().find((e) => e.type.startsWith("explanation_"))?.type;
  const explain: ExplainState =
    explainPage?.url && !explainStale
      ? { status: "ready", url: explainPage.url, stale: false }
      : lastExplainEvent === "explanation_generating"
        ? { status: "generating" }
        : explainPage?.url
          ? { status: "ready", url: explainPage.url, stale: true }
          : null;
  // Live, not the agent's evidence prose (task #1000): recomputed on every
  // review via GET .../branch-check, same as CI/quiz below.
  const unmetDeps = branchCheck?.unmet_deps ?? [];
  const referencedTaskLabel = (ref: { id: string; number: number }) => {
    const fullTask = tasks.find((candidate) => candidate.id === ref.id);
    return fullTask ? taskLabel(fullTask) : `#${ref.number}`;
  };
  const depBlocked =
    reportOnly || !unmetDeps.length
      ? ""
      : `Waiting on ${unmetDeps.map((d) => `${referencedTaskLabel(d)} ${d.title}`).join(", ")} — not yet merged/done`;
  const deliveryBlocked = reportOnly
    ? ""
    : task.ci_status === "failing"
      ? "CI is failing — the agent has been told to iterate; unlocks when green"
      : task.ci_status === "pending"
        ? "CI is still running — wait for green"
        : !task.pr_url && !task.branch
          ? "No PR and no branch — nothing to merge"
          : "";
  const mergeBlocked = quizBlocked || depBlocked || deliveryBlocked;
  const landHeld = isLandHeld({
    landActed,
    landQueuedAt: task.land_queued_at,
    quizStatus,
    passedThisSession: quizOverride === "passed",
    events,
    reviewEventId,
  });
  const embeddedTasks = branchCheck?.embedded_tasks ?? [];
  const failures = [...events]
    .reverse()
    .filter(isFailureEvent);
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
    : quizRequired && missingQuiz
      ? "This older review has no understanding check."
      : mergeBlocked ||
      (reportOnly
        ? "Hive finished the research and submitted its evidence."
        : task.ci_status === "passing"
          ? "CI passed and Hive found no blocking issue."
          : "Hive completed its review and is ready for your approval.");
  // Focus is a queue: picking an action moves to the next item right away
  // instead of holding the card through the round trip. A failure still toasts
  // its reason. Elsewhere (task page, review queue) the card stays put until the
  // call lands, so the error can render on the card itself.
  const start = () => {
    setBusy(true);
    if (surface === "focus") onDone?.();
  };
  const finish = () => {
    if (surface !== "focus") onDone?.();
  };
  // Flagging the card makes it judgment-class, so its checks are required again.
  const requireQuiz = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.requireUnderstandingQuiz(task.id);
      setBranchCheck((prev) => (prev ? { ...prev, understanding_required: true } : prev));
    } finally {
      setBusy(false);
    }
  };
  const merge = async (strategy?: "local_ff", overrideConfirmedRisks?: boolean) => {
    if (busy) return;
    start();
    try {
      if (reportOnly) {
        await api.transition(task.id, "verifying");
        toast("Report accepted");
      } else {
        await api.merge(task.id, strategy, overrideConfirmedRisks);
        toast(strategy ? "Merged locally → Verifying" : "Merged → Verifying");
      }
      finish();
    } catch (e) {
      const msg = (e as Error).message;
      // Keep the reason ON the card — a vanishing toast made failed merges
      // read as "the button silently didn't work". But a conflict bounce
      // moves the task back to in_progress, which unmounts this card before
      // the error renders — so the toast must carry the reason too.
      setMergeErr(msg);
      api.task(task.id).then((t) => setEvents(t.events ?? [])).catch(() => {});
      toast(`Not merged — ${msg}`);
    } finally {
      setBusy(false);
    }
  };
  const requestChanges = async () => {
    if (!notes.trim() || busy) return;
    start();
    try {
      const r = await api.requestChanges(task.id, notes);
      toast(r.delivered ? "Changes requested — sent to agent" : "Changes requested (agent offline; recorded)");
      setNotes("");
      setMode(null);
      finish();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refreshUnderstandingCheck = async () => {
    if (busy) return;
    start();
    try {
      await api.requestChanges(
        task.id,
        "Refresh the existing review_summary without changing the implementation. Preserve the review findings, regenerate the explanation in the current format, and add 1-5 multiple-choice understanding.checks. Each question must help the director understand this specific change or report: its behavior, user impact, risk, tradeoff, or evidence, with the answer taught in the explanation. Do not quiz agent procedures, debugging, merging, tools, or policy. Write every question and option in plain everyday words: one idea per sentence, no nested clauses. Use jargon only if the diff itself introduces the term, and then define it. Make each option plainly distinct from the others. Length follows the content, not a cap: a simple change earns a short question, a genuinely complex change can take the words it needs. Write background, essence, walkthrough, and participate the way you would explain the change to a colleague on the phone: clarity first, brevity second. Then submit the task for review again."
      );
      toast("Agent asked to add the understanding check");
      finish();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setLandMark = async (queued: boolean) => {
    if (busy) return;
    setBusy(true);
    setLandActed(true);
    try {
      await api.landQueue([task.id], queued);
      toast(queued ? "Landing — the queue will merge it" : "Taken out of the land queue");
      const t = await api.task(task.id).catch(() => null);
      if (t) setEvents(t.events ?? []);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    if (!notes.trim() || busy) return;
    start();
    try {
      await api.transition(task.id, "cancelled", notes);
      toast("Rejected — task cancelled");
      setNotes("");
      setMode(null);
      finish();
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
            <TaskRef task={task} className="card-num" />
            {project && <span>{project.name}</span>}
            <span>{task.kind}</span>
          </div>
          <h3 className="review-card-title">
            <Link to={`/tasks/${task.id}`}>{task.title}</Link>
          </h3>
        </div>
        <div className="review-status">
          {task.pr_url ? (
            <PrReference className="pr" url={task.pr_url} label={`${prLabel(task.pr_url)} ↗`} />
          ) : (
            <span className="muted mono-sm">branch {task.branch || "?"}</span>
          )}
          <SidecarChip sidecar={task.sidecar} />
          <CiBadge status={task.ci_status} />
        </div>
      </div>

      {/* Open decision cards are answerable RIGHT HERE — radios, not text. */}
      {openDecisions.map((d) => (
        <DecisionCard key={d.id} d={d} onDone={() => setOpenDecisions((ds) => ds.filter((x) => x.id !== d.id))} />
      ))}

      {/* Stacked-PR flag (task #1000): this branch shares unmerged commits with
          another currently open task's branch, computed live via merge-base — not
          a claim in the agent's evidence. Informational, not blocking: stacked
          branches are sometimes intentional, but the director should know before
          merging that those tasks' later rewrites won't be reflected here.
          One sentence, numbers only — task #1134: listing every title made this
          an 80-line dump nobody could act on. Titles live in the expander. */}
      {embeddedTasks.length > 0 && (
        <div className="review-merge-error" title="Detected via git merge-base against every other open task's branch in this project">
          ⚠ Branch shares unmerged commits with {embeddedTasks.length} active{" "}
          {embeddedTasks.length === 1 ? "task" : "tasks"} (
          {embeddedTasks.slice(0, 3).map((t, index) => (
            <span key={t.id}>{index > 0 && ", "}<TaskReference taskId={t.id} label={referencedTaskLabel(t)} /></span>
          ))}
          {embeddedTasks.length > 3 && `, +${embeddedTasks.length - 3} more`}) — a rebase or rewrite
          there won't propagate here.
          {embeddedTasks.length > 3 && (
            <details className="merge-issues">
              <summary>Which tasks</summary>
              <ol>
                {embeddedTasks.map((t) => (
                  <li key={t.id}><TaskReference taskId={t.id} label={referencedTaskLabel(t)} /> {t.title}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}

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
        <RiskVerdicts events={events} headSha={task.head_sha} />
      </div>

      <VerificationChecklist items={verification} evidence={evidence} />

      <EvidenceStrip evidence={evidence.filter((e) => e.kind !== "explanation")} task={task} />

      <details className="review-details" open={quizStatus === "required"}>
        <summary>
          <span>{reportOnly ? "Explain report" : review?.understanding ? "Understand this change" : "Why Hive recommends this"}</span>
          <small>
            {reportOnly && review?.understanding
              ? `finding · impact · risk`
              : review?.understanding
              ? `mental model · ${evidence.length} evidence`
              : `${review?.done?.length ?? 0} completed · ${caveats.length} caveat${caveats.length === 1 ? "" : "s"} · ${evidence.length} evidence`}
          </small>
        </summary>
        <div className="review-details-body">
          {(review?.understanding || explain) && (
            <ReviewUnderstanding packet={review?.understanding ?? {}} report={reportOnly} caveats={caveats} explain={explain} />
          )}

          <details className="report-audit">
            <summary>
              <span>Full report and audit trail</span>
              <small>{review?.done?.length ?? 0} findings · {evidence.length} evidence</small>
            </summary>
            <div className="report-audit-body">
              <ChangesThread events={events} />

              <CheckpointList events={events} />

              {review ? <ReviewAudit r={review} /> : task.summary && <p className="review-summary">{task.summary}</p>}
              {review && task.summary && <p className="review-summary">{task.summary}</p>}

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
        </div>
      </details>

      {quizRequired && quiz && reviewEventId && quizStatus === "required" && (
        <UnderstandingQuiz
          quiz={{
            task_id: task.id,
            question: quiz.question,
            options: quiz.options,
            version: "version" in quiz ? quiz.version : `${reviewEventId}:0`,
          }}
          allowDefer
          surface={surface}
          onPassed={() => setQuizOverride("passed")}
          onDeferred={() => setQuizOverride("deferred")}
        />
      )}
      {quizRequired && quizStatus === "passed" && <div className="understanding-quiz-status passed">Understanding confirmed. Approval unlocked.</div>}
      {landHeld && (
        <div className="review-blocked review-blocked-action">
          You marked this approved to land before you took the check. It will not merge until you say so.
          <button className="btn btn-mini" disabled={busy} onClick={() => setLandMark(true)}>Land now</button>
          <button className="btn btn-mini" disabled={busy} onClick={() => setLandMark(false)}>Unmark</button>
        </div>
      )}
      {quizStatus === "deferred" && <div className="understanding-quiz-status deferred">Quiz saved in Needs You. You can continue now.</div>}
      {!quizRequired && (
        <div className="understanding-quiz-status deferred">
          Mechanical change: no understanding check needed.{" "}
          <button className="btn btn-mini" onClick={requireQuiz} disabled={busy}>Quiz me on this one</button>
        </div>
      )}

      <div className="review-actions">
        <button className="btn btn-primary" onClick={() => merge()} disabled={busy || !!mergeBlocked} title={mergeBlocked}>
          {busy ? "Working…" : reportOnly ? "Accept report" : surface === "focus" ? "Ship" : "Approve & merge"}
        </button>
        {!task.never_dispatched && (
          <button className="btn" onClick={() => setMode(mode === "changes" ? null : "changes")}>
            Request changes
          </button>
        )}
        <button className="btn btn-danger" onClick={() => setMode(mode === "reject" ? null : "reject")}>
          Reject
        </button>
      </div>
      {missingQuiz && !task.never_dispatched ? (
        <div className="review-blocked review-blocked-action">
          <span>{mergeBlocked}</span>
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
          {mergeErr.includes("override_confirmed_risks") && (
            <button
              className="btn"
              style={{ marginLeft: "var(--s2)" }}
              disabled={busy || !!mergeBlocked}
              title="Merge anyway. The risks above stay on the card as the record of what you accepted."
              onClick={() => merge(undefined, true)}
            >
              Merge anyway
            </button>
          )}
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
      {failures.length > 0 && (
        <details className="merge-issues">
          <summary>{failures.length} recorded failure{failures.length === 1 ? "" : "s"}</summary>
          <ol>
            {failures.map((failure) => (
              <li key={failure.id}>
                <time title={failure.ts}>{relTime(failure.ts)}</time>
                <span>{eventText(failure)}</span>
              </li>
            ))}
          </ol>
        </details>
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

    </section>
  );
}
