// The intent card: what was asked, and the one tap that accepts it (HIVE-636).
//
// Deterministic rendering, no model call — the five sections come straight out
// of body_md. Three actions: Accept, Edit (inline Markdown), and "Ask the
// originator", which adds an open question. An open question holds acceptance,
// so asking one is also how you park an intent you cannot accept yet.
import { useState } from "react";
import { api } from "../lib/api";
import type { Intent } from "../lib/api";
import { addOpenQuestion, answerOpenQuestion, intentSections, openQuestions, questionBullets } from "../lib/intent";
import { toast } from "../lib/ui";

const STATUS_LABEL: Record<Intent["status"], string> = {
  draft: "Draft — waiting on you",
  accepted: "Accepted",
  superseded: "Superseded",
};

// Open questions answered on the card: tick the box (with an optional one-line
// answer) and it is saved as "[x] question — answer" in the Markdown, which is
// what unlocks Accept. No editor round trip for a one-line yes.
function OpenQuestions({ body, busy, onAnswer }: { body: string; busy: boolean; onAnswer: (index: number, answer: string) => void }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  let openIndex = -1;
  return (
    <ul className="intent-questions">
      {questionBullets(body).map((q, i) => {
        if (q.done) {
          return (
            <li key={i} className="intent-q intent-q-done">
              <input type="checkbox" checked readOnly aria-label="Answered" />
              <span>{q.text}</span>
            </li>
          );
        }
        const index = ++openIndex;
        const answer = answers[index] ?? "";
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
              placeholder="Your answer, optional — tick the box to save"
              value={answer}
              disabled={busy}
              onChange={(e) => setAnswers((prev) => ({ ...prev, [index]: e.target.value }))}
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

export function IntentCard({ intent, onChange }: { intent: Intent; onChange?: (next: Intent) => void }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(intent.body_md);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const open = openQuestions(intent.body_md);

  const save = async (body_md: string, done: () => void) => {
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
      // No toast: the card itself flips to "Accepted", which is the feedback.
      onChange?.(await api.acceptIntent(intent.id));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel intent-card" id="intent">
      <h2>Intent</h2>
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
          {intentSections(intent.body_md).map(({ heading, text }) => (
            <div className="intent-section" key={heading}>
              <h3>{heading}</h3>
              {heading === "Open questions" && intent.status === "draft" && questionBullets(intent.body_md).length > 0 ? (
                <OpenQuestions
                  body={intent.body_md}
                  busy={busy}
                  onAnswer={(index, answer) => save(answerOpenQuestion(intent.body_md, index, answer), () => {})}
                />
              ) : (
                <pre className="brief">{text || "(none)"}</pre>
              )}
            </div>
          ))}

          {intent.status === "draft" && (
            <div className="intent-actions">
              {/* Same rule the server enforces, said before the tap rather than
                  as a 409 after it. */}
              <button
                className="btn btn-primary"
                disabled={busy || open.length > 0}
                title={open.length ? `Answer ${open.length} open question${open.length === 1 ? "" : "s"} first` : "Accept this ask"}
                onClick={accept}
              >
                Accept
              </button>
              <button className="btn" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
              <button className="btn" disabled={busy} onClick={() => setAsking((on) => !on)}>Ask the originator</button>
            </div>
          )}

          {open.length > 0 && intent.status === "draft" && (
            <div className="muted intent-open-note">
              {open.length} open question{open.length === 1 ? "" : "s"} to answer before this can be accepted.
            </div>
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
