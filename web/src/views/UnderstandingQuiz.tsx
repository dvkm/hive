import { useState } from "react";
import { api } from "../lib/api";
import type { UnderstandingQuiz as Quiz } from "../lib/api";
import { toast } from "../lib/ui";

export function UnderstandingQuiz({
  quiz,
  allowDefer = false,
  onPassed,
  onDeferred,
}: {
  quiz: Pick<Quiz, "task_id" | "question" | "options">;
  allowDefer?: boolean;
  onPassed?: (explanation: string | null) => void;
  onDeferred?: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const [showEscape, setShowEscape] = useState(false);

  const submit = async () => {
    if (!answer || busy) return;
    setBusy(true);
    try {
      const result = await api.answerUnderstandingQuiz(quiz.task_id, answer);
      if (result.correct) {
        toast("Understanding confirmed");
        onPassed?.(result.explanation);
      } else {
        setWrong(true);
      }
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const defer = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deferUnderstandingQuiz(quiz.task_id);
      toast("Quiz saved for later");
      onDeferred?.();
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="understanding-quiz">
      <div className="understanding-quiz-label">Before you approve</div>
      <h4>{quiz.question}</h4>
      <div className="understanding-quiz-options">
        {quiz.options.map((option) => (
          <label key={option.key} className={answer === option.key ? "selected" : ""}>
            <input
              type="radio"
              name={`understanding-${quiz.task_id}`}
              value={option.key}
              checked={answer === option.key}
              onChange={() => {
                setAnswer(option.key);
                setWrong(false);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {wrong && <p className="understanding-quiz-wrong">Not quite. Try again.</p>}
      <div className="understanding-quiz-actions">
        <button className="btn btn-primary" disabled={!answer || busy} onClick={submit}>
          {busy ? "Checking…" : "Check answer"}
        </button>
        {allowDefer && !showEscape && (
          <button className="link-btn" disabled={busy} onClick={() => setShowEscape(true)}>
            I need to move fast
          </button>
        )}
      </div>
      {allowDefer && showEscape && (
        <div className="understanding-quiz-escape">
          <p>This unlocks shipping now, but the quiz will stay in Needs You until you pass it.</p>
          <button className="btn" disabled={busy} onClick={defer}>Ship now, quiz me later</button>
        </div>
      )}
    </section>
  );
}
