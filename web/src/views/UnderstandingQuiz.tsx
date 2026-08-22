import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { UnderstandingQuiz as Quiz } from "../lib/api";
import { toast } from "../lib/ui";

export function UnderstandingQuiz({
  quiz,
  label = "Before you approve",
  allowDefer = false,
  surface,
  onPassed,
  onDeferred,
}: {
  quiz: Pick<Quiz, "task_id" | "question" | "options" | "version" | "completed" | "total">;
  label?: string;
  allowDefer?: boolean;
  surface?: "focus";
  onPassed?: (explanation: string | null) => void;
  onDeferred?: () => void;
}) {
  const [currentQuiz, setCurrentQuiz] = useState(quiz);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [round, setRound] = useState(0);
  const [showEscape, setShowEscape] = useState(false);
  const optionSignature = currentQuiz.options.map((option) => `${option.key}:${option.label}`).join("|");
  const options = useMemo(() => {
    const shuffled = [...currentQuiz.options];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }, [currentQuiz.question, optionSignature, round]);

  useEffect(() => {
    if (quiz.question === currentQuiz.question && quiz.version === currentQuiz.version) return;
    setCurrentQuiz(quiz);
    setAnswer("");
    setFeedback("");
    setRound((value) => value + 1);
  }, [quiz.question, quiz.version]);

  const submit = async () => {
    if (!answer || busy) return;
    setBusy(true);
    try {
      const result = await api.answerUnderstandingQuiz(currentQuiz.task_id, answer, currentQuiz.version, surface);
      if (result.passed) {
        toast("Understanding confirmed");
        onPassed?.(result.explanation);
      } else if (result.correct && result.quiz) {
        toast(`Correct. ${result.completed} of ${result.total}`);
        setCurrentQuiz({ task_id: currentQuiz.task_id, ...result.quiz });
        setAnswer("");
        setFeedback("");
        setRound((value) => value + 1);
      } else {
        setFeedback(result.explanation || "Review the explanation and apply the idea again.");
        if (result.quiz) setCurrentQuiz({ task_id: currentQuiz.task_id, ...result.quiz });
        setAnswer("");
        setRound((value) => value + 1);
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
      <div className="understanding-quiz-label">
        {label}
        {(currentQuiz.total ?? 1) > 1 && ` · Question ${(currentQuiz.completed ?? 0) + 1} of ${currentQuiz.total}`}
      </div>
      {feedback && <p className="understanding-quiz-wrong">Not quite. {feedback} Try this from another angle.</p>}
      <h4>{currentQuiz.question}</h4>
      <div className="understanding-quiz-options">
        {options.map((option) => (
          <label key={option.key} className={answer === option.key ? "selected" : ""}>
            <input
              type="radio"
              name={`understanding-${quiz.task_id}`}
              value={option.key}
              checked={answer === option.key}
              onChange={() => {
                setAnswer(option.key);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
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
          <p>This unlocks approval now, but the quiz will stay in Needs You until you pass it.</p>
          <button className="btn" disabled={busy} onClick={defer}>Continue now, quiz me later</button>
        </div>
      )}
    </section>
  );
}
