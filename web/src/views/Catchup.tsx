import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { GlanceCard } from "../lib/api";
import { useProjectFilter } from "../lib/projectFilter";
import { Empty } from "../lib/ui";
import { useLightbox } from "../lib/lightbox";
import { relTime } from "../lib/time";

// Catch up on shipped work by LOOKING at it (HIVE-511).
//
// The long explanation page is unchanged and one click away. This page is the
// layer above it: a card you can take in without scrolling — one line of what
// changed, a picture, and four numbers. Drop into the page only when something
// looks off.

// The card renders one line. The server already caps the headline; this is the
// belt to that braces, so a bad payload cannot turn a card into a paragraph.
export const CARD_TEXT_MAX = 140;

export function capLine(text: string, max = CARD_TEXT_MAX): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).replace(/[\s,;:.]+$/, "")}…`;
}

// Where the change landed, when there is no picture to show. Bars beat a
// sentence describing the same thing: the eye reads the shape in a moment.
function AreaBars({ areas }: { areas: GlanceCard["areas"] }) {
  const top = areas[0]?.churn || 1;
  return (
    <ul className="glance-areas" aria-label="Change by area">
      {areas.map((a) => (
        <li key={a.area}>
          <span className="glance-area-name" title={a.area}>{a.area}</span>
          <span className="glance-area-bar"><i style={{ width: `${Math.max(4, Math.round((a.churn / top) * 100))}%` }} /></span>
          <span className="glance-area-churn">{a.churn}</span>
        </li>
      ))}
    </ul>
  );
}

function Visual({ card }: { card: GlanceCard }) {
  const lightbox = useLightbox();
  if (card.images.length) {
    const images = card.images.map((i) => ({ url: i.url, caption: i.caption ?? undefined, taskId: card.task_id, taskTitle: card.title, ts: card.shipped_at }));
    const pair = card.images.length === 2 && card.images[0].phase === "before";
    return (
      <div className={`glance-shots ${pair ? "glance-pair" : ""}`}>
        {card.images.map((image, i) => (
          <button key={image.url} className="glance-shot" onClick={() => lightbox.open(images, i)} title={image.caption || "screenshot"}>
            <img src={image.url} alt={image.caption || "screenshot"} loading="lazy" />
            {pair && <span className="glance-shot-tag">{image.phase === "before" ? "before" : "after"}</span>}
          </button>
        ))}
      </div>
    );
  }
  if (card.areas.length) return <AreaBars areas={card.areas} />;
  // Neither a picture nor a diff shape: say so in the visual's place rather
  // than leaving a hole the eye has to interpret. A scout ships a report, so
  // "no diff" is the answer, not a gap.
  return (
    <p className="glance-noshape">
      {card.kind === "scout" ? "A report, not a code change." : "No diff shape recorded for this change."}
    </p>
  );
}

function Card({ card }: { card: GlanceCard }) {
  return (
    <article className="glance-card">
      <header className="glance-head">
        <Link to={`/tasks/${card.task_id}`}>{card.display_id}</Link>
        <span className="chip chip-kind">{card.kind}</span>
        <span className="chip" title={card.merged_by === "auto" ? "Merged by hive without you" : card.merged_by === "director" ? "You merged this" : "No merge event recorded"}>
          {card.merged_by === "auto" ? "auto-merged" : card.merged_by === "director" ? "you shipped it" : "shipped"}
        </span>
        <span className="glance-when">{relTime(card.shipped_at)}</span>
      </header>
      <p className="glance-line" title={card.title}>{capLine(card.headline) || card.title}</p>
      <Visual card={card} />
      <footer className="glance-facts">
        <span>{card.files} file{card.files === 1 ? "" : "s"}</span>
        <span className="diff-add">+{card.additions}</span>
        <span className="diff-del">−{card.deletions}</span>
        {card.explanation_url ? (
          <a href={card.explanation_url} target="_blank" rel="noreferrer">Explain ↗</a>
        ) : (
          <Link to={`/tasks/${card.task_id}`}>Open</Link>
        )}
      </footer>
    </article>
  );
}

export default function Catchup() {
  const projectFilter = useProjectFilter();
  const [cards, setCards] = useState<GlanceCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCards(null);
    setError(null);
    api
      .catchup(10, projectFilter || undefined)
      .then((r) => live && setCards(r.cards))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [projectFilter]);

  return (
    <div className="glance">
      <div className="page-head">
        <h1 className="page-title">Catch up</h1>
        <p className="page-sub">The last 10 shipped changes, one card each. Look, don&apos;t read.</p>
      </div>
      {error && <Empty title="Could not load the last shipped changes" hint={error} />}
      {!error && cards === null && <p className="muted">Loading…</p>}
      {!error && cards?.length === 0 && (
        <Empty title="Nothing shipped yet" hint="A change lands here once its task reaches done." />
      )}
      <div className="glance-grid">{cards?.map((card) => <Card key={card.task_id} card={card} />)}</div>
    </div>
  );
}
