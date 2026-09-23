// The intent card: what was asked, and the one tap that accepts it (HIVE-636).
//
// Deterministic rendering, no model call — the five sections come straight out
// of body_md. Accept IS the answer to hive's own "is this the ask?" question,
// so a plain yes is one tap; questions people asked are answered on the card
// and hold acceptance until they are. Empty sections are filled in on the card
// too. Edit (raw Markdown) and "Ask the originator" remain for everything else.
import { useState } from "react";
import { api } from "../lib/api";
import type { Intent } from "../lib/api";
import {
  addOpenQuestion,
  answerHiveQuestion,
  answerOpenQuestion,
  intentSections,
  isHiveQuestion,
  openQuestions,
  questionBullets,
  setIntentSection,
} from "../lib/intent";
import { toast } from "../lib/ui";

const STATUS_LABEL: Record<Intent["status"], string> = {
  draft: "Waiting on you",
  accepted: "Accepted",
  superseded: "Replaced",
};

const NOT_STATED = "(not stated)";
const ADD_HINT: Record<string, string> = {
  "Proposed outcome": "What does done look like? Enter to save",
  "Affected users and systems": "Who and what does this touch? Enter to save",
  Constraints: "What must not change? Enter to save",
};

// Questions people asked, answered where they are read: tick the box (with an
// optional one-line answer) and it is saved as "[x] question — answer".
function OpenQuestions({
  body,
  busy,
  onAnswer,
}: {
  body: string;
  busy: boolean;
  onAnswer: (index: number, answer: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const open = openQuestions(body);
  const bullets = questionBullets(body).filter((q) => !isHiveQuestion(q.text));
  return (
    <ul className="intent-questions">
      {bullets.map((q, i) => {
        if (q.done) {
          return (
            <li key={i} className="intent-q intent-q-done">
              <input type="checkbox" checked readOnly aria-label="Answered" />
              <span>{q.text}</span>
            </li>
          );
        }
        const index = open.indexOf(q.text);
        const answer = answers[q.text] ?? "";
        return (
          <li key={i} className="intent-q">
            <input
              type="checkbox"
              checked={false}
              disabled={busy}
              aria-label={`Answer: ${q.text}`}
              onChange={() => onAnswer(index, answer)}
            />
            <span>{q.text}</span>
            <input
              className="intent-q-answer"
              aria-label="Your answer (optional)"
              placeholder="Your answer, optional. Tick the box or press Enter to save."
              value={answer}
              disabled={busy}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.text]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") onAnswer(index, answer);
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}

// An empty section is a line to fill in, not "(not stated)" three times.
function AddLine({ heading, busy, onSave }: { heading: string; busy: boolean; onSave: (text: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="intent-section intent-section-empty">
      <h3>{heading}</h3>
      <input
        className="intent-add"
        aria-label={`Add ${heading.toLowerCase()}`}
        placeholder={ADD_HINT[heading] ?? "Add… Enter to save"}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onSave(value.trim());
        }}
      />
    </div>
  );
}

// brief: Home shows the problem and the questions; the rest of the draft folds away.
export function IntentCard({ intent, onChange, brief = false }: { intent: Intent; onChange?: (next: Intent) => void; brief?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(intent.body_md);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const open = openQuestions(intent.body_md);
  // Only questions people asked hold Accept; hive's own one is answered by accepting.
  const asked = open.filter((q) => !isHiveQuestion(q));
  const isDraft = intent.status === "draft";

  const save = async (body_md: string, done: () => void = () => {}) => {
    setBusy(true);
    try {
      onChange?.(await api.updateIntent(intent.id, { body_md }));
      done();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    try {
      // Accepting is the answer to hive's question, so tick it on the way through:
      // the server's "[x]" gate stays the authority and the Markdown keeps the record.
      const ticked = answerHiveQuestion(intent.body_md);
      if (ticked !== intent.body_md) await api.updateIntent(intent.id, { body_md: ticked });
      // No toast: the card itself flips to "Accepted", which is the feedback.
      onChange?.(await api.acceptIntent(intent.id));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sections = intentSections(intent.body_md);
  const upfront = (heading: string) => !brief || heading === "Problem" || heading === "Open questions";
  const renderSection = ({ heading, text }: { heading: string; text: string }) => {
    if (heading === "Open questions") {
      const shown = questionBullets(intent.body_md).some((q) => !isHiveQuestion(q.text));
      return (
        <div className="intent-section" key={heading}>
          <h3>{heading}</h3>
          {shown && isDraft ? (
            <OpenQuestions body={intent.body_md} busy={busy} onAnswer={(index, answer) => save(answerOpenQuestion(intent.body_md, index, answer))} />
          ) : (
            <p className="intent-prose muted">{shown ? text : "(none)"}</p>
          )}
        </div>
      );
    }
    const empty = !text || text === NOT_STATED;
    if (empty && isDraft && heading !== "Problem") {
      return <AddLine key={heading} heading={heading} busy={busy} onSave={(value) => save(setIntentSection(intent.body_md, heading, value))} />;
    }
    return (
      <div className="intent-section" key={heading}>
        <h3>{heading}</h3>
        <p className={`intent-prose${empty ? " muted" : ""}`}>{text || "(none)"}</p>
      </div>
    );
  };

  return (
    <section className="panel intent-card" id="intent">
      <h2>The ask</h2>
      <div className="intent-meta muted">
        <span className={`chip chip-intent-${intent.status}`}>{STATUS_LABEL[intent.status]}</span>
        <span>from {intent.source}{intent.source_ref ? ` · ${intent.source_ref}` : ""}</span>
        {intent.accepted_by && <span>by {intent.accepted_by}</span>}
      </div>

      {editing ? (
        <>
          <textarea
            className="intent-edit"
            aria-label="Intent Markdown"
            rows={18}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="intent-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => save(draft, () => setEditing(false))}>Save</button>
            <button className="btn" disabled={busy} onClick={() => { setDraft(intent.body_md); setEditing(false); }}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          {sections.filter((s) => upfront(s.heading)).map(renderSection)}
          {brief && (
            <details className="review-details">
              <summary>The rest of the draft</summary>
              <div className="review-details-body">{sections.filter((s) => !upfront(s.heading)).map(renderSection)}</div>
            </details>
          )}

          {isDraft && (
            <>
              <div className="intent-actions">
                <button
                  className="btn btn-primary"
                  disabled={busy || asked.length > 0}
                  title={asked.length ? `Answer ${asked.length} question${asked.length === 1 ? "" : "s"} above first` : "This is the ask: accept it"}
                  onClick={accept}
                >
                  Accept
                </button>
                <button className="btn" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
                <button className="btn" disabled={busy} onClick={() => setAsking((on) => !on)}>Ask the originator</button>
              </div>
              <div className="muted intent-open-note">
                {asked.length
                  ? `${asked.length} open question${asked.length === 1 ? "" : "s"} for you above before this can be accepted.`
                  : "Accept means: this is the ask. Hive then rewrites the task's brief from it and can start the work."}
              </div>
            </>
          )}

          {asking && (
            <div className="intent-ask">
              <input
                aria-label="Question for the originator"
                value={question}
                placeholder="What do you need to know?"
                onChange={(e) => setQuestion(e.target.value)}
              />
              <button
                className="btn"
                disabled={busy || !question.trim()}
                onClick={() => save(addOpenQuestion(intent.body_md, question.trim()), () => { setQuestion(""); setAsking(false); })}
              >
                Add question
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
