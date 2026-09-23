import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { BranchCheck, DiffFile, DiffResult, Evidence, PreviewState, ReviewItem, ReviewSummary, Task, UnderstandingPacket, VerificationItem } from "../lib/api";
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
import { PrReference, TaskReference, prLabel, taskLabel } from "../lib/references";
import { oneLine, whyItWasNeeded, withoutPromoted } from "../lib/reviewFocus";

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

// A BEFORE:/AFTER: caption pair is one thing, not two screenshots that happen
// to share a timestamp (HIVE-611). Rank orders the pair; anything else is 2.
function pairRank(e: Evidence): number {
  const cap = (e.caption ?? "").trimStart();
  if (/^before\b/i.test(cap)) return 0;
  if (/^after\b/i.test(cap)) return 1;
  return 2;
}

// Oldest first, except that each before/after pair sits together at the
// earliest time either half was captured, and reads before → after however it
// was emitted. Without this the AFTER shot can land first and the reader meets
// the outcome before the problem. Two pairs on one task stay two pairs: the
// n-th BEFORE belongs with the n-th AFTER, not with every other BEFORE.
export function orderEvidence(evidence: Evidence[]): Evidence[] {
  const byTs = (a: Evidence, b: Evidence) => a.ts.localeCompare(b.ts);
  const befores = evidence.filter((e) => pairRank(e) === 0).sort(byTs);
  const afters = evidence.filter((e) => pairRank(e) === 1).sort(byTs);
  const slot = new Map<string, string>();
  for (let i = 0; i < Math.max(befores.length, afters.length); i++) {
    const pair = [befores[i], afters[i]].filter((e): e is Evidence => !!e);
    const ts = pair.reduce((min, e) => (min && min < e.ts ? min : e.ts), "");
    for (const e of pair) slot.set(e.id, `${ts}#${String(i).padStart(4, "0")}`);
  }
  const key = (e: Evidence) => slot.get(e.id) ?? e.ts;
  return [...evidence].sort(
    (a, b) => key(a).localeCompare(key(b)) || pairRank(a) - pairRank(b) || a.ts.localeCompare(b.ts)
  );
}

export function EvidenceStrip({ evidence, task, limit }: { evidence: Evidence[]; task: Pick<Task, "id" | "title" | "head_sha">; limit?: number }) {
  const lightbox = useLightbox();
  if (!evidence.length) return null;
  const ordered = orderEvidence(evidence);
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
        // The caption is the only thing telling two shots of the same screen
        // apart, so it is on the card, not in a tooltip (HIVE-611).
        <figure key={e.id} className="rev-thumb-fig">
          <button className="rev-thumb" title={e.caption || "screenshot"} onClick={() => lightbox.open(lightboxImages, images.findIndex((image) => image.id === e.id))}>
            <img src={e.url} alt={e.caption || "screenshot"} />
            <EvAge e={e} headSha={task.head_sha} />
          </button>
          {e.caption && <figcaption className="rev-thumb-cap" title={e.caption}>{e.caption}</figcaption>}
        </figure>
      ) : <EvChip key={e.id} e={e} headSha={task.head_sha} />)}
      {limit && evidence.length > limit && <Link className="brief-evidence-more" to={`/tasks/${task.id}`}>+{evidence.length - limit} more</Link>}
    </div>
  );
}

import type { Decision, Event } from "../lib/api";

// The pre-review's risks and questions, after the per-risk check re-read the
// real code for this head (HIVE-406/407).
export interface RiskItem {
  kind: "confirmed" | "refuted" | "human" | "answered" | "unchecked";
  text: string;
  detail?: string;
}

// Splits the pre-review's findings into what still needs the director and what
// the check already settled. Verdicts recorded for an older head are ignored:
// they say nothing about what is about to merge.
export function riskVerdictSplit(
  events: Event[],
  headSha: string | null
): { open: RiskItem[]; settled: RiskItem[]; flagged: boolean } | null {
  const review = [...events].reverse().find((e) => e.type === "auto_review" && !e.payload.skipped);
  const verdictEvent = headSha
    ? [...events].reverse().find((e) => e.type === "risk_verdicts" && e.payload.reviewed_head_sha === headSha)
    : undefined;
  if (!review || !verdictEvent) return null;
  const risks = (verdictEvent.payload.verdicts ?? []) as { risk: string; verdict: string; why?: string; evidence_path?: string }[];
  const questions = (verdictEvent.payload.question_verdicts ?? []) as { question: string; answerable: string; answer?: string }[];
  const unverified = Number(verdictEvent.payload.unverified) || 0;
  if (!risks.length && !questions.length && !unverified) return null;
  const open: RiskItem[] = [];
  const settled: RiskItem[] = [];
  for (const r of risks)
    (r.verdict === "confirmed" ? open : settled).push({
      kind: r.verdict === "confirmed" ? "confirmed" : "refuted",
      text: r.risk,
      detail: [r.why, r.evidence_path].filter(Boolean).join(" \u00b7 "),
    });
  for (const q of questions)
    (q.answerable === "human" ? open : settled).push({
      kind: q.answerable === "human" ? "human" : "answered",
      text: q.question,
      detail: q.answer ?? "",
    });
  if (unverified > 0) open.push({ kind: "unchecked", text: `${unverified} finding${unverified === 1 ? "" : "s"} could not be checked` });
  return { open, settled, flagged: review.payload.verdict === "caution" };
}

const RISK_CHIP: Record<RiskItem["kind"], string> = {
  confirmed: "confirmed",
  refuted: "refuted",
  human: "you answer",
  answered: "answered",
  unchecked: "unchecked",
};

// HIVE-557: only what is still open gets space. A refuted finding means "we
// checked, it is not a problem" — that is a count, not two paragraphs, and it
// used to sit ABOVE the one question the director actually had to answer.
export function RiskVerdicts({ events, headSha }: { events: Event[]; headSha: string | null }) {
  const split = riskVerdictSplit(events, headSha);
  if (!split) return null;
  const { open, settled } = split;
  return (
    <div className="risk-verdicts">
      {open.length > 0 && (
        <span className="risk-verdicts-label">
          {open.length} still open
        </span>
      )}
      {open.length > 0 && (
        <ul>
          {open.map((item, i) => (
            <li key={i} className={item.kind === "confirmed" ? "rv-confirmed" : "rv-human"}>
              <span className="rv-chip">{RISK_CHIP[item.kind]}</span>
              <span className="rv-text rv-open" title={item.detail ?? ""}>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {settled.length > 0 && (
        <details className="risk-settled">
          <summary>
            Pre-review checked {settled.length} other finding{settled.length === 1 ? "" : "s"} — none of them a problem
          </summary>
          <ul>
            {settled.map((item, i) => (
              <li key={i} className="rv-refuted">
                <span className="rv-chip">{RISK_CHIP[item.kind]}</span>
                <span className="rv-text" title={item.detail ?? ""}>
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

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

// The top of the card, in the order a person decides (HIVE-557): what changed,
// what state it left behind, why it was needed. Everything else collapses.
// The agent's LATEST self-review that actually carries sections (early buggy
// submissions stored {note:null}). Shared so the verify card reads exactly the
// same review the review card did.
export function latestReviewSummaryEvent(events: Event[]): Event | undefined {
  return [...events]
    .reverse()
    .find(
      (e: any) =>
        e.type === "review_summary" &&
        e.payload &&
        (["done", "iffy", "decisions", "testing", "followups"].some((k) => (e.payload[k] ?? []).length) ||
          (e.payload.understanding && typeof e.payload.understanding === "object"))
    );
}

// #1249: hive writes one page per PR head explaining the change, stored as
// ordinary evidence, so the newest one is the current one. #1556: a page
// written for an older head is shown but labelled, never passed off as current.
export function explainStateOf(evidence: Evidence[], events: Event[], headSha: string | null): ExplainState {
  const pages = [...evidence].reverse().filter((e) => e.kind === "explanation" && e.url);
  // Same match rule as the server's explanationFor(): a page counts as current
  // only when its recorded commit is the PR's head.
  const current = headSha ? pages.find((e) => e.meta?.commit_sha === headSha) : pages[0];
  const page = current ?? pages[0];
  const stale = !!page && !current;
  const lastEvent = [...events].reverse().find((e) => e.type.startsWith("explanation_"))?.type;
  if (page?.url && !stale) return { status: "ready", url: page.url, stale: false };
  if (lastEvent === "explanation_generating") return { status: "generating" };
  return page?.url ? { status: "ready", url: page.url, stale: true } : null;
}

// The lead is the agent's own plain-English essence of the change and the
// reason it was needed. The diff-stat and the before/after table that used to
// sit here were engineer readouts (the table fired on 1.4% of review lines);
// counts live in the trail now.
function ReviewFocus({ changed, why }: { changed: string; why: string }) {
  if (!changed && !why) return null;
  return (
    <div className="review-focus">
      {changed && (
        <div className="focus-block">
          <span className="focus-eyebrow">What changed</span>
          <p className="focus-lead">{changed}</p>
        </div>
      )}
      {why && (
        <div className="focus-block">
          <span className="focus-eyebrow">Why it was needed</span>
          <p className="focus-why">{why}</p>
        </div>
      )}
    </div>
  );
}

// What a reviewer weighs before the button: the agent's caveats and the calls
// it made on its own. Up to three on the card, the rest in the trail, none twice.
function WatchOut({ items }: { items: ReviewItem[] }) {
  if (!items.length) return null;
  return (
    <div className="focus-block review-watch">
      <span className="focus-eyebrow">Watch out for</span>
      <ul>
        {items.map((it, i) => (
          <li key={i}>
            {reviewItemText(it)}
            {typeof it !== "string" && it.why && <span className="rs-why"> — {it.why}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function watchOutsOf(review: ReviewSummary | null | undefined, max = 3): ReviewItem[] {
  return [...(review?.iffy ?? []), ...(review?.decisions ?? [])].slice(0, max);
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

// ---------------------------------------------------------------- preview
// A running copy of the branch, so UI work is verified by LOOKING at it instead
// of by reading a diff or waiting for staging (HIVE-629). Renders nothing at
// all unless the project opted in with config.preview — `preview` is absent
// from the task payload otherwise.
function PreviewPanel({ task, screenshots }: { task: Task; screenshots: Evidence[] }) {
  const [state, setState] = useState<PreviewState | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setState(undefined);
    const load = () =>
      api
        .preview(task.id)
        .then((r) => live && setState(r.preview))
        .catch(() => live && setState(null));
    void load();
    // A stack takes minutes to build, and a queued one starts when a slot
    // frees. Poll while either is true; a settled card polls nothing.
    const timer = setInterval(() => {
      setState((s) => {
        if (s && (s.status === "building" || s.status === "queued")) void load();
        return s;
      });
    }, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [task.id]);

  if (state === undefined || state === null) return null;

  const act = async (start: boolean) => {
    setBusy(true);
    try {
      const r = start ? await api.startPreview(task.id) : await api.stopPreview(task.id);
      setState(r.preview);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deep = state.preview_path;
  const primary = state.urls[0];
  const smoke =
    state.smoke_passed == null
      ? null
      : `smoke ${state.smoke_passed} passed, ${state.smoke_failed ?? 0} failed`;

  return (
    <div className={`preview-panel preview-${state.status}`}>
      <div className="preview-head">
        <span className="preview-label">Preview</span>
        {state.status === "idle" && (
          <button className="preview-action" disabled={busy} onClick={() => act(true)}>
            Build preview
          </button>
        )}
        {state.status === "expired" && (
          <button className="preview-action" disabled={busy} onClick={() => act(true)}>
            Preview expired · Rebuild
          </button>
        )}
        {state.status === "failed" && (
          <button className="preview-action" disabled={busy} onClick={() => act(true)}>
            Retry
          </button>
        )}
        {state.status === "ready" && (
          <button className="preview-action preview-stop" disabled={busy} onClick={() => act(false)}>
            Tear down
          </button>
        )}
      </div>

      {state.status === "building" && <p className="preview-note">Bringing the stack up{"…"} this takes a few minutes.</p>}
      {state.status === "queued" && (
        <p className="preview-note">Waiting for a free slot — three previews can run at once. It starts on its own.</p>
      )}

      {state.status === "ready" && (
        <>
          <div className="preview-links">
            {deep && primary && (
              <a className="preview-link preview-link-primary" href={`${primary.url}${deep}`} target="_blank" rel="noreferrer">
                open the page I changed ↗
              </a>
            )}
            {state.urls.map((u) => (
              <a key={u.label} className="preview-link" href={u.url} target="_blank" rel="noreferrer">
                {u.label} ↗
              </a>
            ))}
          </div>
          {state.login_hint && <p className="preview-note preview-login">login: {state.login_hint}</p>}
          {smoke && <p className="preview-note">{smoke}</p>}
        </>
      )}

      {state.status === "failed" && (
        <>
          <p className="preview-note">The stack did not come up.</p>
          {state.tail && <pre className="preview-tail">{state.tail}</pre>}
        </>
      )}

      {/* Fallback: no live stack, but the agent captured the page itself. Say
          plainly that these are pictures, not a running site. */}
      {(state.status === "failed" || state.status === "queued" || state.status === "expired") && screenshots.length > 0 && (
        <p className="preview-note">
          No live stack — the {screenshots.length} screenshot{screenshots.length === 1 ? "" : "s"} below {screenshots.length === 1 ? "is" : "are"} what the agent captured.
        </p>
      )}
    </div>
  );
}

// The review surface on the task page: PR+CI status, what changed and why, a
// compact diff stat with an expandable inline diff, and the three primary
// actions (approve & merge, request changes, reject). `onDone` lets the parent
// refresh after an action resolves.
export function ReviewCard({ task, onDone }: { task: Task; onDone?: () => void }) {
  const { tasks = [] } = useStore();
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffErr, setDiffErr] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<ActionMode>(null);
  const [notes, setNotes] = useState("");
  const [review, setReview] = useState<ReviewSummary | null>(null);
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
        const ev = latestReviewSummaryEvent(t.events ?? []);
        if (ev) setReview(ev.payload as ReviewSummary);
        setEvidence(t.evidence ?? []);
        setVerification(t.verification ?? []);
        setEvents(t.events ?? []);
        setOpenDecisions((t.decisions ?? []).filter((d: Decision) => d.status === "open"));
        const mergeReason = t.health?.status === "stuck" && /^merge (?:failed|blocked): /.test(t.health.reason ?? "")
          ? t.health!.reason!.replace(/^merge (?:failed|blocked): /, "")
          : "";
        setMergeErr(mergeReason);
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

  // The CTA must not promise what the state can't deliver ("Approve & merge"
  // on red CI / no PR was a lie that failed on click). Scouts and no-change
  // chores have nothing to merge; accepting the report is the whole review.
  const isScout = task.kind === "scout";
  const reportOnly = isScout || (task.kind === "chore" && diff?.files.length === 0);
  // The risk check already ran, back when the PR reached review (HIVE-570). If
  // it confirmed something, Ship cannot work, so the card says so before the
  // director presses anything.
  const confirmedRisks = branchCheck?.confirmed_risks ?? [];
  const riskUnfinished = branchCheck?.risk_check_unfinished ?? null;
  const riskBlocked = reportOnly
    ? ""
    : confirmedRisks.length
      ? `The risk check confirmed ${confirmedRisks.length} risk${confirmedRisks.length === 1 ? "" : "s"} on this commit: ` +
        confirmedRisks.map((r) => r.risk).join("; ") +
        ". Send it back to the agent, or merge anyway below."
      : riskUnfinished
        ? `The risk check did not finish on this commit — ${riskUnfinished.unverified} of ` +
          `${riskUnfinished.unverified + riskUnfinished.checked} finding${riskUnfinished.unverified + riskUnfinished.checked === 1 ? "" : "s"} ` +
          `got no verdict${riskUnfinished.reason ? ` (${riskUnfinished.reason})` : ""}. Nothing was confirmed. It retries on its own.`
        : "";
  const explain = explainStateOf(evidence, events, task.head_sha);
  // Live, not the agent's evidence prose (task #1000): recomputed on every
  // review via GET .../branch-check, same as CI below.
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
  const mergeBlocked = riskBlocked || depBlocked || deliveryBlocked;
  const embeddedTasks = branchCheck?.embedded_tasks ?? [];
  const failures = [...events]
    .reverse()
    .filter(isFailureEvent);
  const caveats = review?.iffy ?? [];
  // What the card leads with (HIVE-557). The pre-review's summary is written
  // from the diff itself, so it goes first; the agent's own essence is the
  // fallback, and its first Completed line the last resort. Capped either way.
  const autoReviewSummary = [...events].reverse().find((e) => e.type === "auto_review" && !e.payload.skipped)?.payload
    ?.summary as string | undefined;
  // The agent's own plain-English essence leads. The pre-review's summary is
  // written from the diff in engineer voice, so it is the fallback, not the lead.
  const whatChangedSource = review?.understanding?.essence || autoReviewSummary || review?.done?.[0] || "";
  const whatChanged = oneLine(whatChangedSource);
  const why = whyItWasNeeded(review?.understanding?.background, review?.done ?? []);
  // A sentence promoted into the lead is not repeated in the collapsed audit.
  const promoted = [why.source, whatChangedSource].filter(Boolean);
  const watchOuts = watchOutsOf(review);
  const auditReview = review
    ? {
        ...review,
        done: withoutPromoted(review.done, promoted, (d) => d),
        testing: withoutPromoted(review.testing, promoted, (t) => t),
        iffy: (review.iffy ?? []).filter((item) => !watchOuts.includes(item)),
        decisions: (review.decisions ?? []).filter((item) => !watchOuts.includes(item)),
      }
    : null;
  // Screenshots are the evidence a person judges at a glance; everything else is
  // a chip in the trail, counted in the summary line.
  const screenshots = evidence.filter((e) => e.kind === "screenshot");
  const attachments = evidence.filter((e) => e.kind !== "screenshot" && e.kind !== "explanation");
  // The mental model repeats itself too: whatever the lead already said is
  // dropped from the packet rather than printed a second time lower down.
  const packet = review?.understanding
    ? {
        ...review.understanding,
        essence: promoted.includes(review.understanding.essence ?? "") ? undefined : review.understanding.essence,
        background: promoted.includes(review.understanding.background ?? "") || why.text ? undefined : review.understanding.background,
      }
    : undefined;
  // An unanswered question addressed to the director IS a blocking issue: the
  // card used to recommend "approve and merge" six lines above one (HIVE-557).
  const openRisks = riskVerdictSplit(events, task.head_sha)?.open ?? [];
  const openQuestions = openRisks.filter((r) => r.kind === "human").length;
  const recommendation = openDecisions.length
    ? "Make the open decision first"
    : mergeBlocked
      ? "Wait to merge"
      : openQuestions
        ? reportOnly
          ? `Answer the open question${openQuestions === 1 ? "" : "s"}, then accept`
          : `Answer the open question${openQuestions === 1 ? "" : "s"}, then merge`
        : reportOnly
          ? "Accept this report"
          : "Approve and merge";
  const recommendationReason = openDecisions.length
    ? `${openDecisions.length} decision${openDecisions.length === 1 ? "" : "s"} still need your judgment.`
    : mergeBlocked ||
      (openQuestions
        ? `Nothing else is blocking, but ${openQuestions === 1 ? "one question needs" : `${openQuestions} questions need`} an answer only you have.`
        : reportOnly
        ? "Hive finished the research and submitted its evidence."
        : task.ci_status === "passing"
          ? "CI passed and Hive found no blocking issue."
          : "Hive completed its review and is ready for your approval.");
  // The card stays put until the call lands, so an error renders on the card.
  const merge = async (strategy?: "local_ff", overrideConfirmedRisks?: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (reportOnly) {
        await api.transition(task.id, "verifying");
        toast("Report accepted");
      } else {
        await api.merge(task.id, strategy, overrideConfirmedRisks);
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
      api.task(task.id).then((t) => setEvents(t.events ?? [])).catch(() => {});
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

  // No heading of its own: the task page above it already names the task.
  return (
    <section className="review-card">
      <div className="review-card-head">
        <div className="review-status">
          {task.pr_url && <PrReference className="pr" url={task.pr_url} label={`${prLabel(task.pr_url)} ↗`} />}
          {/* Green is the default and says nothing; only a warning, a red run or
              a CI that never ran earns a chip. */}
          {task.sidecar && !task.sidecar.ok && <SidecarChip sidecar={task.sidecar} />}
          {task.ci_status !== "passing" && <CiBadge status={task.ci_status} />}
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

      <PreviewPanel task={task} screenshots={evidence.filter((e) => e.kind === "screenshot")} />

      <ReviewFocus changed={whatChanged} why={why.text} />

      {/* What needs the director, the recommendation that has to agree with it,
          then the caveats and judgment calls a reviewer weighs (once). */}
      <div className={`review-recommendation ${openRisks.length ? "review-recommendation-open" : ""}`}>
        <span className="review-recommendation-label">{openRisks.length ? "Needs you" : "Hive recommends"}</span>
        <strong>{recommendation}</strong>
        <p>{recommendationReason}</p>
        <RiskVerdicts events={events} headSha={task.head_sha} />
      </div>

      <WatchOut items={watchOuts} />

      <VerificationChecklist items={verification} evidence={evidence} />

      <EvidenceStrip evidence={screenshots} task={task} />

      <details className="review-details">
        <summary>
          <span>{reportOnly ? "Explain report" : review?.understanding ? "Understand this change" : "Why Hive recommends this"}</span>
          <small>
            {reportOnly && review?.understanding
              ? `finding · impact · risk`
              : review?.understanding
              ? `how it works · ${evidence.length} evidence`
              : `${auditReview?.done?.length ?? 0} completed · ${evidence.length} evidence`}
          </small>
        </summary>
        <div className="review-details-body">
          {(review?.understanding || explain) && (
            <ReviewUnderstanding packet={packet ?? {}} report={reportOnly} caveats={caveats} explain={explain} />
          )}

          <details className="report-audit">
            <summary>
              <span>Full report and audit trail</span>
              <small>{auditReview?.done?.length ?? 0} findings · {evidence.length} evidence</small>
            </summary>
            <div className="report-audit-body">
              <ChangesThread events={events} />

              <EvidenceStrip evidence={attachments} task={task} />

              <CheckpointList events={events} />

              {auditReview ? <ReviewAudit r={auditReview} /> : task.summary && <p className="review-summary">{task.summary}</p>}
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

      {/* Why the button is off comes BEFORE the button, so the eye meets the
          reason first. */}
      {mergeBlocked && (
        <div className={confirmedRisks.length ? "review-blocked review-blocked-action" : "review-blocked"}>
          {mergeBlocked}
          {confirmedRisks.length > 0 && (
            <button
              className="btn btn-mini"
              disabled={busy}
              title="Merge anyway. The confirmed risks stay on the card as the record of what you accepted."
              onClick={() => merge(undefined, true)}
            >
              Merge anyway
            </button>
          )}
        </div>
      )}

      <div className="review-actions">
        <button className="btn btn-primary" onClick={() => merge()} disabled={busy || !!mergeBlocked} title={mergeBlocked}>
          {busy ? "Working…" : reportOnly ? "Accept report" : "Approve & merge"}
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
      {mergeErr && (
        <div className="review-merge-error">
          Merge failed: {mergeErr}
          {mergeErr.includes("override_confirmed_risks") && (
            <button
              className="btn"
              style={{ marginLeft: "var(--s2)" }}
              disabled={busy || !!(depBlocked || deliveryBlocked)}
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
