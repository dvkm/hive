import { useEffect, useMemo, useRef, useState } from "react";
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
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.answerUnderstandingQuiz>> | null>(null);
  const [round, setRound] = useState(0);
  const [showEscape, setShowEscape] = useState(false);
  const ignoredVersion = useRef<string | null>(null);
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
    if (quiz.task_id !== currentQuiz.task_id) {
      ignoredVersion.current = null;
      setCurrentQuiz(quiz);
      setAnswer("");
      setResult(null);
      setRound((value) => value + 1);
      return;
    }
    if (busy || result || quiz.version === ignoredVersion.current) return;
    ignoredVersion.current = null;
    if (quiz.question === currentQuiz.question && quiz.version === currentQuiz.version) return;
    setCurrentQuiz(quiz);
    setAnswer("");
    setResult(null);
    setRound((value) => value + 1);
  }, [quiz.task_id, quiz.question, quiz.version, busy, result]);

  const submit = async () => {
    if (!answer || busy || result) return;
    setBusy(true);
    try {
      setResult(await api.answerUnderstandingQuiz(currentQuiz.task_id, answer, currentQuiz.version, surface));
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const advance = () => {
    if (!result) return;
    if (result.passed) {
      onPassed?.(result.explanation);
      return;
    }
    if (!result.quiz) return;
    ignoredVersion.current = currentQuiz.version;
    setCurrentQuiz({ task_id: currentQuiz.task_id, ...result.quiz });
    setAnswer("");
    setResult(null);
    setRound((value) => value + 1);
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
      {result && (
        <p className={result.correct ? "understanding-quiz-correct" : "understanding-quiz-wrong"}>
          {result.correct ? "Correct." : `Not quite. ${result.explanation || "Review the explanation and apply the idea again."} Try this from another angle.`}
        </p>
      )}
      <h4>{currentQuiz.question}</h4>
      <div className="understanding-quiz-options">
        {options.map((option) => (
          <label
            key={option.key}
            className={answer === option.key ? `selected${result ? result.correct ? " correct" : " incorrect" : ""}` : ""}
          >
            <input
              type="radio"
              name={`understanding-${quiz.task_id}`}
              value={option.key}
              checked={answer === option.key}
              disabled={Boolean(result)}
              onChange={() => {
                setAnswer(option.key);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <div className="understanding-quiz-actions">
        {result ? (
          <button className="btn btn-primary" onClick={advance}>
            {result.passed ? "Finish" : "Next question"}
          </button>
        ) : (
          <button className="btn btn-primary" disabled={!answer || busy} onClick={submit}>
            {busy ? "Checking…" : "Check answer"}
          </button>
        )}
        {allowDefer && !result && !showEscape && (
          <button className="link-btn" disabled={busy} onClick={() => setShowEscape(true)}>
            I need to move fast
          </button>
        )}
      </div>
      {allowDefer && !result && showEscape && (
        <div className="understanding-quiz-escape">
          <p>This unlocks approval now, but the quiz will stay in Needs You until you pass it.</p>
          <button className="btn" disabled={busy} onClick={defer}>Continue now, quiz me later</button>
        </div>
      )}
    </section>
  );
}
