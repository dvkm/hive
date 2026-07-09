import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Decision } from "../lib/api";
import { useStore } from "../lib/store";
import { toast } from "../lib/ui";

function DecisionCard({ d, onDone }: { d: Decision; onDone: (id: string) => void }) {
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

  return (
    <article className="dcard">
      <header className="dcard-head">
        <h2>{d.title}</h2>
        <Link className="dcard-task" to={`/tasks/${d.task_id}`}>
          task {d.task_id.slice(0, 8)} →
        </Link>
      </header>

      {d.context && <p className="dcard-context">{d.context}</p>}

      <div className={`blast risk-${d.risk || "unknown"}`}>
        <div className="blast-label">
          Risk: <strong>{d.risk || "unknown"}</strong>
        </div>
        {d.blast_radius && <div className="blast-body">{d.blast_radius}</div>}
      </div>

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
      <div className="dcard-foot">
        <span className="save-state">{saving ? "saving draft…" : note ? "draft saved" : ""}</span>
        <button className="btn btn-primary btn-submit" disabled={submitting} onClick={submit}>
          {submitting ? "Submitting…" : "Submit decision"}
        </button>
      </div>
    </article>
  );
}

export default function Decisions() {
  const { decisions } = useStore();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const list = decisions.filter((d) => !hidden.has(d.id));
  const hide = (id: string) => setHidden((h) => new Set(h).add(id));

  return (
    <div className="inbox">
      {list.length === 0 && (
        <div className="empty">
          <div className="empty-big">Inbox zero</div>
          <div className="muted">No decisions need you right now.</div>
        </div>
      )}
      {list.map((d) => (
        <DecisionCard key={d.id} d={d} onDone={hide} />
      ))}
    </div>
  );
}
