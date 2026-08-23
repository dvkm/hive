import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { api, type UnderstandingQuiz as Quiz } from "../src/lib/api";
import { UnderstandingQuiz } from "../src/views/UnderstandingQuiz";

const first: Pick<Quiz, "task_id" | "question" | "options" | "version" | "completed" | "total"> = {
  task_id: "task-1",
  question: "First question?",
  options: [{ key: "a", label: "Answer A" }, { key: "b", label: "Answer B" }],
  version: "review-1:0",
  completed: 0,
  total: 2,
};

const second = {
  question: "Second question?",
  options: [{ key: "c", label: "Answer C" }, { key: "d", label: "Answer D" }],
  version: "review-1:1",
  completed: 1,
  total: 2,
};

test("a graded answer stays highlighted until Next question is clicked", async () => {
  const original = api.answerUnderstandingQuiz;
  api.answerUnderstandingQuiz = (async () => ({
    ok: true,
    correct: true,
    passed: false,
    explanation: "Because A is correct.",
    completed: 1,
    total: 2,
    quiz: second,
  })) as typeof api.answerUnderstandingQuiz;

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<UnderstandingQuiz quiz={first} />);
    });
    const answer = renderer.root.find((node) => node.type === "input" && node.props.value === "a");
    await act(async () => answer.props.onChange());
    await act(async () => {
      await renderer.root.find((node) => node.type === "button" && node.children.includes("Check answer")).props.onClick();
    });

    expect(renderer.root.findByType("h4").children).toEqual(["First question?"]);
    expect(renderer.root.find((node) => node.type === "label" && node.findAll((child) => child.type === "input" && child.props.value === "a").length > 0).props.className).toContain("correct");
    expect(renderer.root.findAll((node) => node.type === "input").every((node) => node.props.disabled)).toBe(true);

    await act(async () => {
      renderer.update(<UnderstandingQuiz quiz={{ task_id: first.task_id, ...second }} />);
    });
    expect(renderer.root.findByType("h4").children).toEqual(["First question?"]);

    await act(async () => {
      renderer.root.find((node) => node.type === "button" && node.children.includes("Next question")).props.onClick();
    });
    expect(renderer.root.findByType("h4").children).toEqual(["Second question?"]);
  } finally {
    api.answerUnderstandingQuiz = original;
  }
});

test("the final answer waits for Finish before completing the quiz", async () => {
  const original = api.answerUnderstandingQuiz;
  api.answerUnderstandingQuiz = (async () => ({
    ok: true,
    correct: true,
    passed: true,
    explanation: "Done.",
    completed: 1,
    total: 1,
  })) as typeof api.answerUnderstandingQuiz;
  let passed = false;

  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<UnderstandingQuiz quiz={{ ...first, total: 1 }} onPassed={() => { passed = true; }} />);
    });
    await act(async () => renderer.root.find((node) => node.type === "input" && node.props.value === "a").props.onChange());
    await act(async () => {
      await renderer.root.find((node) => node.type === "button" && node.children.includes("Check answer")).props.onClick();
    });

    expect(passed).toBe(false);
    expect(renderer.root.findByType("h4").children).toEqual(["First question?"]);
    await act(async () => renderer.root.find((node) => node.type === "button" && node.children.includes("Finish")).props.onClick());
    expect(passed).toBe(true);
  } finally {
    api.answerUnderstandingQuiz = original;
  }
});
