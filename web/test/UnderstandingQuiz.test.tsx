import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { api, type UnderstandingQuiz as Quiz } from "../src/lib/api";
import { UnderstandingQuiz } from "../src/views/UnderstandingQuiz";

// The store keys quiz state by task_id and keeps it for the session, so each
// test needs its own task id or it inherits the previous test's question.
let ids = 0;
const seed = (over: Partial<Quiz> = {}) => ({ ...base, task_id: `task-${++ids}`, ...over });

const base: Pick<Quiz, "task_id" | "question" | "options" | "version" | "completed" | "total"> = {
  task_id: "task-0",
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

  const first = seed();
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

  const first = seed({ total: 1 });
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<UnderstandingQuiz quiz={first} onPassed={() => { passed = true; }} />);
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

test("a stale 409 swaps in the current question instead of a red toast (hive-2121)", async () => {
  const original = api.answerUnderstandingQuiz;
  api.answerUnderstandingQuiz = (async () => {
    throw Object.assign(new Error("understanding check already changed by director (web-7a9b8ac0)"), {
      status: 409,
      body: { stale: true, resolution: { actor: "web-7a9b8ac0", quiz: second } },
    });
  }) as typeof api.answerUnderstandingQuiz;

  const first = seed();
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<UnderstandingQuiz quiz={first} />);
    });
    await act(async () => renderer.root.find((node) => node.type === "input" && node.props.value === "a").props.onChange());
    await act(async () => {
      await renderer.root.find((node) => node.type === "button" && node.children.includes("Check answer")).props.onClick();
    });

    expect(renderer.root.findByType("h4").children).toEqual(["Second question?"]);
    expect(renderer.root.findAll((node) => node.props?.className === "understanding-quiz-notice")).toHaveLength(1);
    // No answer carried over, and the button points at the new version.
    expect(renderer.root.findAll((node) => node.type === "input").every((node) => !node.props.checked)).toBe(true);
    expect(renderer.root.find((node) => node.type === "button" && node.children.includes("Check answer")).props.disabled).toBe(true);
  } finally {
    api.answerUnderstandingQuiz = original;
  }
});

test("a self-conflict refresh swaps in the current question (hive-2121)", async () => {
  const original = api.answerUnderstandingQuiz;
  api.answerUnderstandingQuiz = (async () => ({
    ok: true,
    refreshed: true,
    passed: false,
    explanation: null,
    completed: 1,
    total: 2,
    quiz: second,
  })) as unknown as typeof api.answerUnderstandingQuiz;

  const first = seed();
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<UnderstandingQuiz quiz={first} />);
    });
    await act(async () => renderer.root.find((node) => node.type === "input" && node.props.value === "a").props.onChange());
    await act(async () => {
      await renderer.root.find((node) => node.type === "button" && node.children.includes("Check answer")).props.onClick();
    });

    expect(renderer.root.findByType("h4").children).toEqual(["Second question?"]);
    // No graded result panel: nothing was graded.
    expect(renderer.root.findAll((node) => node.props?.className === "understanding-quiz-correct")).toHaveLength(0);
  } finally {
    api.answerUnderstandingQuiz = original;
  }
});

test("two mounts of the same task share one question (hive-2125)", async () => {
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

  const first = seed();
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<><UnderstandingQuiz quiz={first} /><UnderstandingQuiz quiz={first} label="Second view" /></>);
    });
    expect(renderer.root.findAllByType("h4").map((node) => node.children)).toEqual([["First question?"], ["First question?"]]);

    // Answer in the first mount and click through to the next question.
    const [a] = renderer.root.findAll((node) => node.type === "input" && node.props.value === "a");
    await act(async () => a.props.onChange());
    await act(async () => {
      await renderer.root.findAll((node) => node.type === "button" && node.children.includes("Check answer"))[0].props.onClick();
    });
    await act(async () => {
      renderer.root.find((node) => node.type === "button" && node.children.includes("Next question")).props.onClick();
    });

    // Both mounts moved to the new version without a click or a refetch.
    expect(renderer.root.findAllByType("h4").map((node) => node.children)).toEqual([["Second question?"], ["Second question?"]]);
    expect(renderer.root.findAll((node) => node.type === "input").every((node) => !node.props.checked)).toBe(true);
  } finally {
    api.answerUnderstandingQuiz = original;
  }
});
