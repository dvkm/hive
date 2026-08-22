import { useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type { Decision, DecisionBundle, DecisionPlan } from "../lib/api";
import { riskDisplay } from "../lib/decision";
import { toast } from "../lib/ui";
import { PrReference, ReferenceText } from "../lib/references";
import { relTime } from "../lib/time";

// One decision card: options (recommended first), risk/blast radius, autosaved
// draft note, Submit. Shared by the Chief exchange, Needs you, and detailed
// decision views so the card is answerable wherever it appears (product rule 3).
// `onDone` lets the host optimistically archive it after a submit.
export function DecisionCard({ d, onDone }: { d: Decision; onDone: (id: string) => void }) {
  const recommended = d.options.find((o) => o.recommended);
  const [choice, setChoice] = useState(recommended?.key || d.options[0]?.key || "");
  const [note, setNote] = useState(d.draft_note || "");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Planner breakdown cards: which proposed tasks are checked (all, by default)
  // and a free-text answer per open question, folded into the note on submit.
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  const selected = new Set(d.plan?.proposed_tasks.map((_, i) => i).filter((i) => !excluded.has(i)) ?? []);
  const toggleTask = (i: number) =>
    setExcluded((s) => {
      const next = new Set(s);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  const [answers, setAnswers] = useState<string[]>([]);
  const setAnswer = (i: number, v: string) =>
    setAnswers((a) => {
      const next = [...a];
      next[i] = v;
      return next;
    });

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
      // Question answers ride along as a labeled block ahead of the free-text
      // note — there's no separate field for them on the decision.
      const qa = (d.plan?.questions ?? [])
        .map((q, i) => (answers[i]?.trim() ? `Q: ${q}\nA: ${answers[i].trim()}` : null))
        .filter(Boolean)
        .join("\n\n");
      const combinedNote = [qa, note].filter(Boolean).join("\n\n") || undefined;
      const selectedIndices = d.plan ? [...selected].sort((a, b) => a - b) : undefined;
      await api.answerDecision(d.id, choice, combinedNote, selectedIndices);
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
  const riskDetail = d.blast_radius || d.plan?.reason;
  const hasOptions = options.length > 0;

  return (
    <article className="dcard" id={`dcard-${d.id}`}>
      <header className="dcard-head">
        <h2><ReferenceText text={d.title} taskId={d.task_id} bundle={d.bundle} /></h2>
        <Link className="dcard-task" to={`/tasks/${d.task_id}`}>
          task {d.task_id.slice(0, 8)} →
        </Link>
      </header>

      {d.plan ? (
        <PlanView decisionId={d.id} plan={d.plan} selected={selected} onToggle={toggleTask} answers={answers} onAnswer={setAnswer} />
      ) : (
        d.context && (
          <section className="dcard-brief">
            <div className="dcard-brief-label">Decision brief</div>
            <p className="dcard-context"><ReferenceText text={d.context} taskId={d.task_id} bundle={d.bundle} /></p>
          </section>
        )
      )}

      {(d.risk || riskDetail) && (
        <div className={`blast ${risk.className}`}>
          <div className="blast-label">
            Risk: <strong>{risk.label}</strong>
          </div>
          {riskDetail && <div className="blast-body">{riskDetail}</div>}
        </div>
      )}

      <DecisionBundleView bundle={d.bundle} />

      {!hasOptions && (
        <p className="dcard-context">This decision has no options. Dismiss it to clear the card.</p>
      )}

      {hasOptions && (
        <>
          <div className="options">
            {options.map((o) => {
              const detail = d.plan && o.key === "approve" ? `Create ${selected.size} task(s).` : o.detail;
              return (
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
                    {detail && <div className="opt-detail">{detail}</div>}
                  </div>
                </label>
              );
            })}
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
          <button className="btn btn-primary btn-submit" disabled={submitting || !!(d.plan && choice === "approve" && selected.size === 0)} onClick={submit}>
            {submitting ? "Submitting…" : "Submit decision"}
          </button>
        )}
      </div>
    </article>
  );
}

// A planner breakdown: proposed tasks as a checklist (uncheck to exclude one
// from "Approve breakdown") and open questions as inline answer fields, in
// place of the old plain-text dump of both under `context`.
function PlanView({
  decisionId,
  plan,
  selected,
  onToggle,
  answers,
  onAnswer,
}: {
  decisionId: string;
  plan: DecisionPlan;
  selected: Set<number>;
  onToggle: (i: number) => void;
  answers: string[];
  onAnswer: (i: number, v: string) => void;
}) {
  const instanceId = useId();

  return (
    <div className="dplan">
      {plan.rationale && <p className="dcard-context">{plan.rationale}</p>}

      {plan.proposed_tasks.length > 0 && (
        <div className="dplan-section">
          <div className="dplan-label">
            Proposed tasks ({selected.size}/{plan.proposed_tasks.length} selected)
          </div>
          <div className="options">
            {plan.proposed_tasks.map((t, i) => (
              <label key={i} className={`opt ${selected.has(i) ? "opt-sel" : ""}`}>
                <input type="checkbox" checked={selected.has(i)} onChange={() => onToggle(i)} />
                <div className="opt-body">
                  <div className="opt-label">
                    {t.title}
                    <span className={`chip chip-kind chip-${t.kind}`}>{t.kind}</span>
                  </div>
                  {t.brief && <div className="opt-detail">{firstLine(t.brief)}</div>}
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {plan.questions.length > 0 && (
        <div className="dplan-section">
          <div className="dplan-label">Open questions</div>
          <div className="dplan-questions">
            {plan.questions.map((q, i) => (
              <div key={i} className="pquestion">
                <div className="pquestion-text">
                  <label htmlFor={`${instanceId}-d-${decisionId}-question-${i}`}>{q}</label>
                </div>
                <input
                  id={`${instanceId}-d-${decisionId}-question-${i}`}
                  className="pquestion-input"
                  type="text"
                  placeholder="Your answer…"
                  value={answers[i] ?? ""}
                  onChange={(e) => onAnswer(i, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function firstLine(s: string): string {
  const line = s.split("\n")[0];
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}

// This card talks about the checks, so say whether its facts are still true.
// A changed signal is the loud case: the card was written about one result and
// the checks now say another, so don't let it read as current.
function CiFreshness({ ci }: { ci: NonNullable<DecisionBundle["ci"]> }) {
  const checked = ci.checked_at ? relTime(ci.checked_at) : "not since this card was written";
  return (
    <div className={ci.changed ? "dbundle-ci dbundle-ci-changed" : "dbundle-ci"}>
      {ci.changed ? (
        <span>
          Checks changed since this card: {ci.at_card} → {ci.status ?? "unknown"}. Re-checked {checked}.
        </span>
      ) : (
        <span>
          Checks still {ci.status ?? ci.at_card}. Re-checked {checked}.
        </span>
      )}
      {ci.outage && (
        <div>
          These checks are an infrastructure outage, not this PR.{" "}
          {ci.outage.fix_task_number ? `Hive is already fixing it in #${ci.outage.fix_task_number}. ` : ""}
          Your answer covers every PR blocked by it.
        </div>
      )}
    </div>
  );
}

// The server-derived context that lets the director decide without opening the
// task: the affected PR/branch + spend, and how they've answered before on this
// project. Renders nothing when no bundle is present (older SSE payloads, tests).
function DecisionBundleView({ bundle }: { bundle?: DecisionBundle | null }) {
  if (!bundle) return null;
  const { pr_url, branch, spend_usd, prior_decisions, ci } = bundle;
  const hasFacts = pr_url || branch || spend_usd > 0;
  if (!hasFacts && prior_decisions.length === 0 && !ci) return null;

  return (
    <div className="dbundle">
      {ci && <CiFreshness ci={ci} />}
      {hasFacts && (
        <div className="dbundle-facts">
          {pr_url && (
            <PrReference className="dbundle-fact" url={pr_url} />
          )}
          {branch && !pr_url && <span className="dbundle-fact">{branch}</span>}
          {spend_usd > 0 && <span className="dbundle-fact">${spend_usd.toFixed(2)} spent</span>}
        </div>
      )}
      {prior_decisions.length > 0 && (
        <details className="dbundle-prior">
          <summary>Past decisions ({prior_decisions.length})</summary>
          <div className="dbundle-prior-list">
            {prior_decisions.map((p) => (
              <div key={p.id} className="dbundle-prior-row">
                <span className="dbundle-prior-title">{p.title}</span>
                {p.answer && <span className="dbundle-prior-answer">→ {p.answer}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
