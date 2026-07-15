import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Decision, DecisionBundle } from "../lib/api";
import { riskDisplay } from "../lib/decision";
import { toast } from "../lib/ui";

// One decision card: options (recommended first), risk/blast radius, autosaved
// draft note, Submit. Shared by the Decisions inbox and the Morning Brief so the
// card is answerable wherever it appears (product rule 3). `onDone` lets the host
// optimistically archive it after a submit.
export function DecisionCard({ d, onDone }: { d: Decision; onDone: (id: string) => void }) {
  const recommended = d.options.find((o) => o.recommended);
  const [choice, setChoice] = useState(recommended?.key || d.options[0]?.key || "");
  const [note, setNote] = useState(d.draft_note || "");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Options: recommended first (product rule 3).
  const options = useMemo(
    () => [...d.options].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended)),
    [d.options]
  );

  // Debounced draft autosave on every keystroke.
  const onNote = (v: string) => {
    setNote(v);
    clearTimeout(timer.current);
    setSaving(true);
    timer.current = setTimeout(() => {
      api
        .decisionDraft(d.id, v)
        .catch(() => {})
        .finally(() => setSaving(false));
    }, 500);
  };

  const submit = async () => {
    if (!choice) return;
    setSubmitting(true);
    try {
      await api.answerDecision(d.id, choice, note || undefined);
      toast("Decision submitted");
      onDone(d.id); // optimistic archive
    } catch (e) {
      toast((e as Error).message);
      setSubmitting(false);
    }
  };

  // Dismiss: clear the card without answering (always available; the only action
  // when a card somehow has no options).
  const dismiss = async () => {
    setSubmitting(true);
    try {
      await api.dismissDecision(d.id);
      toast("Decision dismissed");
      onDone(d.id); // optimistic archive
    } catch (e) {
      toast((e as Error).message);
      setSubmitting(false);
    }
  };

  const risk = riskDisplay(d.risk);
  const hasOptions = options.length > 0;

  return (
    <article className="dcard" id={`dcard-${d.id}`}>
      <header className="dcard-head">
        <h2>{d.title}</h2>
        <Link className="dcard-task" to={`/tasks/${d.task_id}`}>
          task {d.task_id.slice(0, 8)} →
        </Link>
      </header>

      {d.context && <p className="dcard-context">{d.context}</p>}

      <div className={`blast ${risk.className}`}>
        <div className="blast-label">
          Risk: <strong>{risk.label}</strong>
        </div>
        {d.blast_radius && <div className="blast-body">{d.blast_radius}</div>}
      </div>

      <DecisionBundleView bundle={d.bundle} />

      {!hasOptions && (
        <p className="dcard-context">This decision has no options. Dismiss it to clear the card.</p>
      )}

      {hasOptions && (
        <>
          <div className="options">
            {options.map((o) => (
              <label key={o.key} className={`opt ${choice === o.key ? "opt-sel" : ""}`}>
                <input
                  type="radio"
                  name={`d-${d.id}`}
                  checked={choice === o.key}
                  onChange={() => setChoice(o.key)}
                />
                <div className="opt-body">
                  <div className="opt-label">
                    {o.label}
                    {o.recommended && <span className="rec">Recommended</span>}
                  </div>
                  {o.detail && <div className="opt-detail">{o.detail}</div>}
                </div>
              </label>
            ))}
          </div>

          <textarea
            className="dnote"
            placeholder="Note (optional, autosaved as you type)…"
            value={note}
            onChange={(e) => onNote(e.target.value)}
          />
        </>
      )}

      <div className="dcard-foot">
        <span className="save-state">{saving ? "saving draft…" : note ? "draft saved" : ""}</span>
        <button className="btn" disabled={submitting} onClick={dismiss}>
          Dismiss
        </button>
        {hasOptions && (
          <button className="btn btn-primary btn-submit" disabled={submitting} onClick={submit}>
            {submitting ? "Submitting…" : "Submit decision"}
          </button>
        )}
      </div>
    </article>
  );
}

// The server-derived context that lets the director decide without opening the
// task: the affected PR/branch + spend, and how they've answered before on this
// project. Renders nothing when no bundle is present (older SSE payloads, tests).
function DecisionBundleView({ bundle }: { bundle?: DecisionBundle | null }) {
  if (!bundle) return null;
  const { pr_url, branch, spend_usd, prior_decisions } = bundle;
  const hasFacts = pr_url || branch || spend_usd > 0;
  if (!hasFacts && prior_decisions.length === 0) return null;

  return (
    <div className="dbundle">
      {hasFacts && (
        <div className="dbundle-facts">
          {pr_url && (
            <a className="dbundle-fact" href={pr_url} target="_blank" rel="noreferrer">
              {prLabel(pr_url)}
            </a>
          )}
          {branch && !pr_url && <span className="dbundle-fact">{branch}</span>}
          {spend_usd > 0 && <span className="dbundle-fact">${spend_usd.toFixed(2)} spent</span>}
        </div>
      )}
      {prior_decisions.length > 0 && (
        <div className="dbundle-prior">
          <div className="dbundle-label">You've decided before</div>
          {prior_decisions.map((p) => (
            <div key={p.id} className="dbundle-prior-row">
              <span className="dbundle-prior-title">{p.title}</span>
              {p.answer && <span className="dbundle-prior-answer">→ {p.answer}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// "owner/repo#123" from a GitHub PR URL; the raw URL otherwise.
function prLabel(url: string): string {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : url;
}
