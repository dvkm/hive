import { expect, test } from "bun:test";
import { act, create } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { Ctx, type Store } from "../src/lib/store";
import { LightboxProvider } from "../src/lib/lightbox";
import { api } from "../src/lib/api";
import type { Task, TaskDetail } from "../src/lib/api";
import { ReviewCard } from "../src/views/ReviewCard";
import { UnderstandingQuiz } from "../src/views/UnderstandingQuiz";

const fakeStore = { projects: [], quizzes: [] } as unknown as Store;

const task = (id: string, source: string | null = "agent"): Task => ({
  id,
  number: 1,
  project_id: "project",
  title: `Task ${id}`,
  brief: "",
  state: "in_review",
  kind: "ship",
  agent_target: null,
  worktree_path: null,
  branch: "task-branch",
  pr_url: "https://github.com/org/repo/pull/1",
  ci_status: "passing",
  head_sha: null,
  summary: null,
  source,
  source_ref: null,
  parent_task_id: null,
  duplicate_of: null,
  depends_on: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const detail = (id: string, source: string | null): TaskDetail => ({
  ...task(id, source),
  events: [],
  evidence: [],
  decisions: [],
});

// api.diff/api.task/api.branchCheck hit real fetch() otherwise; ReviewCard's
// own effect is the only thing that calls them, so stubbing these is enough.
api.diff = (async () => ({ files: [], truncated: false })) as typeof api.diff;
api.task = (async (id: string) => detail(id, "agent")) as typeof api.task;
api.branchCheck = (async () => ({ unmet_deps: [], embedded_tasks: [] })) as typeof api.branchCheck;

function tree(t: Task) {
  return (
    <MemoryRouter>
      <Ctx.Provider value={fakeStore}>
        <LightboxProvider>
          <ReviewCard task={t} />
        </LightboxProvider>
      </Ctx.Provider>
    </MemoryRouter>
  );
}

test("Focus keeps explicit Ship and Request changes actions after understanding is confirmed", async () => {
  const originalTask = api.task;
  api.task = (async (id: string) => passingDetail(id)) as typeof api.task;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <MemoryRouter>
          <Ctx.Provider value={fakeStore}>
            <LightboxProvider><ReviewCard task={task("focus-review")} surface="focus" /></LightboxProvider>
          </Ctx.Provider>
        </MemoryRouter>
      );
    });
    expect(renderer.root.findAll((n) => n.type === "button" && n.children.includes("Ship"))).toHaveLength(1);
    expect(renderer.root.findAll((n) => n.type === "button" && n.children.includes("Request changes"))).toHaveLength(1);
  } finally {
    api.task = originalTask;
  }
});

test("re-rendering ReviewCard in place with a different task resets mode/notes", async () => {
  const taskA = task("task-a");
  const taskB = task("task-b", "external");

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(taskA));
  });

  const requestChangesBtn = renderer.root.findAll(
    (n) => n.type === "button" && n.children.includes("Request changes")
  )[0];
  await act(async () => {
    requestChangesBtn.props.onClick();
  });
  const textarea = renderer.root.findAllByType("textarea")[0];
  await act(async () => {
    textarea.props.onChange({ target: { value: "please fix the thing" } });
  });
  expect(renderer.root.findAllByType("textarea")[0].props.value).toBe("please fix the thing");

  // Same-route navigation: React re-renders the same instance in place,
  // it does not unmount/remount ReviewCard.
  await act(async () => {
    renderer.update(tree(taskB));
  });

  expect(renderer.root.findAllByType("textarea").length).toBe(0);

  // Reopening "Request changes" on the new task must start from empty notes,
  // not whatever was typed for the previous task.
  const requestChangesBtnB = renderer.root.findAll(
    (n) => n.type === "button" && n.children.includes("Request changes")
  )[0];
  await act(async () => {
    requestChangesBtnB.props.onClick();
  });
  expect(renderer.root.findAllByType("textarea")[0].props.value).toBe("");
});

// A detail whose understanding check is already passed, so quizBlocked is
// false and deliveryBlocked is false (pr_url set, ci_status passing) — the
// merge button's enabled/disabled state is then caused ONLY by branch-check,
// not by some other pre-existing block (task #1000's two tests below rely on
// this isolation, per the "does this check even test the thing" principle).
function passingDetail(id: string): TaskDetail {
  return {
    ...task(id, "agent"),
    events: [
      {
        id: "rev-1",
        task_id: id,
        ts: "2026-01-01T00:00:00.000Z",
        source: "agent",
        type: "review_summary",
        payload: { understanding: { check: { question: "Q?", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }], answer_key: "a" } } },
      } as any,
      {
        id: "quiz-1",
        task_id: id,
        ts: "2026-01-01T00:00:01.000Z",
        source: "director",
        type: "understanding_quiz_passed",
        payload: { review_event_id: "rev-1" },
      } as any,
    ],
    evidence: [],
    decisions: [],
  };
}

// HIVE-421: approved to land FIRST, understanding check passed AFTER. The
// approval predates the insight, so the queue must ask before it merges.
function landMarkedThenPassedDetail(id: string): TaskDetail {
  const base = passingDetail(id);
  return {
    ...base,
    land_queued_at: "2026-01-01T00:00:00.500Z",
    events: [
      base.events[0],
      { id: "land-1", task_id: id, ts: "2026-01-01T00:00:00.500Z", source: "director", type: "land_queued", payload: {} } as any,
      base.events[1],
    ],
  };
}

test("a quiz passed after the land mark asks for a Land now tap instead of merging (HIVE-421)", async () => {
  const originalTask = api.task;
  const originalLandQueue = api.landQueue;
  const calls: { ids: string[]; queued: boolean }[] = [];
  api.task = (async (id: string) => landMarkedThenPassedDetail(id)) as typeof api.task;
  api.landQueue = (async (ids: string[], queued = true) => {
    calls.push({ ids, queued });
    return { changed: ids, queued };
  }) as typeof api.landQueue;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree({ ...task("land-held"), land_queued_at: "2026-01-01T00:00:00.500Z" }));
    });
    const landNow = renderer.root.findAll((n) => n.type === "button" && n.children.includes("Land now"));
    const unmark = renderer.root.findAll((n) => n.type === "button" && n.children.includes("Unmark"));
    expect(landNow).toHaveLength(1);
    expect(unmark).toHaveLength(1);

    // toast() reaches for a DOM this renderer has none of; the tap itself is
    // what matters here.
    const doc = (globalThis as any).document;
    (globalThis as any).document = { createElement: () => ({ style: {}, className: "", classList: { add() {}, remove() {} }, remove() {} }), body: { appendChild() {} } };
    try {
      await act(async () => {
        await landNow[0].props.onClick();
      });
    } finally {
      (globalThis as any).document = doc;
    }
    expect(calls).toEqual([{ ids: ["land-held"], queued: true }]);
  } finally {
    api.task = originalTask;
    api.landQueue = originalLandQueue;
  }
});

// HIVE-421 steer: the pass happens in THIS session (no quiz_passed event yet),
// so the hold comes from the in-session pass. Tapping "Land now" must clear it
// right away — the director just confirmed, the card must not still read held.
test("passing the quiz then tapping Land now clears the hold in the same session", async () => {
  const originalTask = api.task;
  const originalLandQueue = api.landQueue;
  const calls: { ids: string[]; queued: boolean }[] = [];
  // Only the review_summary — the quiz is passed below, in-session.
  api.task = (async (id: string) => ({ ...passingDetail(id), events: [passingDetail(id).events[0]] })) as typeof api.task;
  api.landQueue = (async (ids: string[], queued = true) => {
    calls.push({ ids, queued });
    return { changed: ids, queued };
  }) as typeof api.landQueue;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree({ ...task("land-same-session"), land_queued_at: "2026-01-01T00:00:00.500Z" }));
    });
    expect(renderer.root.findAll((n) => n.type === "button" && n.children.includes("Land now"))).toHaveLength(0);

    await act(async () => {
      renderer.root.findByType(UnderstandingQuiz).props.onPassed();
    });
    const landNow = renderer.root.findAll((n) => n.type === "button" && n.children.includes("Land now"));
    expect(landNow).toHaveLength(1);

    const doc = (globalThis as any).document;
    (globalThis as any).document = { createElement: () => ({ style: {}, className: "", classList: { add() {}, remove() {} }, remove() {} }), body: { appendChild() {} } };
    try {
      await act(async () => {
        await landNow[0].props.onClick();
      });
    } finally {
      (globalThis as any).document = doc;
    }
    expect(calls).toEqual([{ ids: ["land-same-session"], queued: true }]);
    // The card now reads as queued to land, not as held awaiting a tap.
    expect(renderer.root.findAll((n) => n.type === "button" && n.children.includes("Land now"))).toHaveLength(0);
    expect(renderer.root.findAll((n) => n.type === "button" && n.children.includes("Unmark"))).toHaveLength(0);
  } finally {
    api.task = originalTask;
    api.landQueue = originalLandQueue;
  }
});

test("a task that is not queued to land shows no land prompt", async () => {
  const originalTask = api.task;
  api.task = (async (id: string) => passingDetail(id)) as typeof api.task;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree(task("not-queued")));
    });
    expect(renderer.root.findAll((n) => n.type === "button" && n.children.includes("Land now"))).toHaveLength(0);
  } finally {
    api.task = originalTask;
  }
});

// task #1000: the merge decision must reflect the LIVE branch-check, not just
// whatever the agent's own review_summary claims. An unmet dependency
// disables the merge button; a shared-history branch shows an explicit flag
// without blocking (stacked branches are sometimes intentional).
test("an unmet dependency from branch-check disables Approve & merge", async () => {
  const originalTask = api.task;
  const originalBranchCheck = api.branchCheck;
  api.task = (async (id: string) => passingDetail(id)) as typeof api.task;
  api.branchCheck = (async () => ({
    unmet_deps: [{ id: "dep-1", number: 974, title: "consolidate the shared definition", state: "in_progress" }],
    embedded_tasks: [],
  })) as typeof api.branchCheck;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree(task("blocked-by-dep")));
    });
    const approveBtn = renderer.root.findAll(
      (n) => n.type === "button" && n.children.includes("Approve & merge")
    )[0];
    expect(approveBtn.props.disabled).toBe(true);
    expect(approveBtn.props.title).toContain("#974");
  } finally {
    api.task = originalTask;
    api.branchCheck = originalBranchCheck;
  }
});

// task #1134: the flag used to spell out every task's title inline — 80+ of
// them on one consuming-project card, with the actual risk buried at the very end. It
// must stay one glanceable sentence no matter how many tasks are involved.
test("many stacked branches collapse to one sentence, not a title dump", async () => {
  const originalTask = api.task;
  const originalBranchCheck = api.branchCheck;
  api.task = (async (id: string) => passingDetail(id)) as typeof api.task;
  const many = Array.from({ length: 16 }, (_, i) => ({
    id: `other-${i}`,
    number: 1100 + i,
    title: `a very long in-flight task title number ${i} that must not appear inline`,
  }));
  api.branchCheck = (async () => ({ unmet_deps: [], embedded_tasks: many })) as typeof api.branchCheck;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree(task("stacked")));
    });
    const flag = renderer.root.findAll(
      (n) => n.type === "div" && typeof n.props.className === "string" && n.props.className.includes("review-merge-error")
    )[0];
    // The sentence itself: count + first three linked numbers + overflow, no titles.
    // Direct text children exclude the task-reference components and expander.
    const sentence = flag.children.filter((c) => typeof c === "string").join("");
    expect(sentence).toContain("16");
    expect(sentence).toContain("+13 more");
    expect(sentence).not.toContain("must not appear inline");
    const references = flag.findAll((n) => n.type === "a" && n.children.some((child) => typeof child === "string" && child.startsWith("#")));
    expect(references.slice(0, 3).map((reference) => reference.children.join(""))).toEqual(["#1100", "#1101", "#1102"]);
    // The rest is still reachable, just collapsed.
    const details = flag.findAll((n) => n.type === "details");
    expect(details.length).toBe(1);
    const listed = details[0].findAll((n) => n.type === "li").map((li) => li.children.join(""));
    expect(listed.length).toBe(16);
    expect(listed[0]).toContain("must not appear inline");
  } finally {
    api.task = originalTask;
    api.branchCheck = originalBranchCheck;
  }
});

test("with no unmet dependency, a stacked branch is flagged but does not block merge", async () => {
  const originalTask = api.task;
  const originalBranchCheck = api.branchCheck;
  api.task = (async (id: string) => passingDetail(id)) as typeof api.task;
  api.branchCheck = (async () => ({
    unmet_deps: [],
    embedded_tasks: [{ id: "other-1", number: 977, title: "some other in-flight task" }],
  })) as typeof api.branchCheck;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree(task("stacked")));
    });
    const approveBtn = renderer.root.findAll(
      (n) => n.type === "button" && n.children.includes("Approve & merge")
    )[0];
    expect(approveBtn.props.disabled).toBe(false);
    const flag = renderer.root.findAll(
      (n) => n.type === "div" && typeof n.props.className === "string" && n.props.className.includes("review-merge-error")
    );
    expect(flag.length).toBe(1);
    expect(flag[0].findAll((n) => n.type === "a" && n.children.includes("#977"))).toHaveLength(1);
  } finally {
    api.task = originalTask;
    api.branchCheck = originalBranchCheck;
  }
});

// A never-dispatched external task (source=external, never spawned — see
// server/src/supervision.ts) has no agent to bounce back to. The server
// rejects request-changes for it outright; the control shouldn't be offered.
test("Request changes is hidden for a never-dispatched external task", async () => {
  const t: Task = { ...task("never-dispatched", "external"), never_dispatched: true };

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });

  const requestChangesBtn = renderer.root.findAll(
    (n) => n.type === "button" && n.children.includes("Request changes")
  );
  expect(requestChangesBtn.length).toBe(0);
});

// "Have agent add it" (shown when the review has no understanding quiz yet)
// calls the same requestChanges API as "Request changes" above — same gap,
// same fix.
test("Have agent add it is hidden for a never-dispatched external task", async () => {
  const t: Task = { ...task("never-dispatched-quiz", "external"), never_dispatched: true };

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });

  const haveAgentBtn = renderer.root.findAll(
    (n) => n.type === "button" && n.children.includes("Have agent add it")
  );
  expect(haveAgentBtn.length).toBe(0);

  // The button is gone, but the blocked-reason text left behind must not still
  // tell the director to ask an agent that was never dispatched.
  const blockedText = JSON.stringify(
    renderer.root.findAll((n) => n.type === "div" && typeof n.props.className === "string" && n.props.className.includes("review-blocked")).map((n) => n.children)
  );
  expect(blockedText).not.toContain("Ask the agent to refresh its review");
  expect(blockedText).toContain("never been dispatched");
});

// #1556: the explanation page is the mental model, so it is embedded in the
// card. A page written for an older head is shown but labelled; while hive is
// still writing one, the card says so instead of showing nothing.
function explainDetail(id: string, evidenceSha: string | null, headSha: string | null, generating = false): TaskDetail {
  const base = passingDetail(id);
  return {
    ...base,
    head_sha: headSha,
    events: generating
      ? [...base.events, { id: "gen-1", task_id: id, ts: "2026-01-01T00:00:02.000Z", source: "hive", type: "explanation_generating", payload: { head_sha: headSha } } as any]
      : base.events,
    evidence: evidenceSha === null
      ? []
      : [{ id: "ev-1", task_id: id, ts: "2026-01-01T00:00:03.000Z", kind: "explanation", url: `/evidence/${id}/1_explanation.html`, caption: "Explanation of this change", meta: { commit_sha: evidenceSha } } as any],
  };
}

async function renderReview(t: Task) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(t));
  });
  return renderer;
}

test("the explanation page for the current head is embedded as a sandboxed iframe", async () => {
  const originalTask = api.task;
  api.task = (async (id: string) => explainDetail(id, "abc123", "abc123")) as typeof api.task;
  try {
    const renderer = await renderReview({ ...task("explain-current"), head_sha: "abc123" });
    // Other test files may install a phone-sized global window while Bun runs
    // files concurrently. Open the responsive disclosure when needed; this
    // test is about the iframe boundary, while the phone test below owns the
    // initial collapsed-state assertion.
    let frame = renderer.root.findAllByType("iframe").find((f) => String(f.props.className).includes("explain-embed-frame"));
    if (!frame) {
      const open = renderer.root.findAll(
        (n) => n.type === "button" && n.children.includes("Open visual explanation")
      )[0];
      expect(open).toBeTruthy();
      await act(async () => open.props.onClick());
      frame = renderer.root.findAllByType("iframe").find((f) => String(f.props.className).includes("explain-embed-frame"));
    }
    expect(frame).toBeTruthy();
    expect(frame!.props.sandbox).toBe("allow-scripts");
    expect(frame!.props.src).toBe("/evidence/explain-current/1_explanation.html");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("older commit");
  } finally {
    api.task = originalTask;
  }
});

test("an explanation written for an older head is labelled stale", async () => {
  const originalTask = api.task;
  api.task = (async (id: string) => explainDetail(id, "old111", "new222")) as typeof api.task;
  try {
    const renderer = await renderReview({ ...task("explain-stale"), head_sha: "new222" });
    expect(JSON.stringify(renderer.toJSON())).toContain("older commit");
  } finally {
    api.task = originalTask;
  }
});

test("while the explanation is generating the card says so instead of showing nothing", async () => {
  const originalTask = api.task;
  api.task = (async (id: string) => explainDetail(id, null, "new222", true)) as typeof api.task;
  try {
    const renderer = await renderReview({ ...task("explain-generating"), head_sha: "new222" });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("Hive is drawing it for this commit");
    expect(renderer.root.findAllByType("iframe").filter((f) => String(f.props.className).includes("explain-embed-frame")).length).toBe(0);
  } finally {
    api.task = originalTask;
  }
});

test("on a phone the embed collapses to an Open visual explanation button", async () => {
  const originalTask = api.task;
  // No DOM in this runner, so ExplainEmbed's width probe sees no window and
  // defaults to expanded; a stub window is how a phone viewport is expressed here.
  (globalThis as any).window = { innerWidth: 390 };
  api.task = (async (id: string) => explainDetail(id, "abc123", "abc123")) as typeof api.task;
  try {
    const renderer = await renderReview({ ...task("explain-phone"), head_sha: "abc123" });
    expect(JSON.stringify(renderer.toJSON())).toContain("Open visual explanation");
    expect(renderer.root.findAllByType("iframe").filter((f) => String(f.props.className).includes("explain-embed-frame")).length).toBe(0);
  } finally {
    api.task = originalTask;
    delete (globalThis as any).window;
  }
});

// HIVE-407: the card shows what the risk check decided, one chip per item, so
// the director reads "confirmed" or "refuted" instead of the raw caution blob.
function verdictDetail(id: string, verdictHead: string): TaskDetail {
  const base = passingDetail(id);
  return {
    ...base,
    head_sha: "head-1",
    events: [
      ...base.events,
      {
        id: "rev-auto",
        task_id: id,
        ts: "2026-01-01T00:00:04.000Z",
        source: "system",
        type: "auto_review",
        payload: { verdict: "caution", summary: "s", risks: ["drops the lock early"], questions: ["is the flag on?"], reviewed_head_sha: "head-1" },
      } as any,
      {
        id: "rev-verdicts",
        task_id: id,
        ts: "2026-01-01T00:00:05.000Z",
        source: "system",
        type: "risk_verdicts",
        payload: {
          reviewed_head_sha: verdictHead,
          verdicts: [{ risk: "drops the lock early", verdict: "confirmed", why: "line 12 releases it" }],
          question_verdicts: [{ question: "is the flag on?", answerable: "human", answer: "check the console" }],
        },
      } as any,
    ],
  };
}

test("risk verdicts render as per-item chips on the review card", async () => {
  const originalTask = api.task;
  api.task = (async (id: string) => verdictDetail(id, "head-1")) as typeof api.task;
  try {
    const renderer = await renderReview({ ...task("verdicts"), head_sha: "head-1" });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain("drops the lock early");
    expect(json).toContain("confirmed");
    expect(json).toContain("you answer");
    expect(json).toContain("rv-confirmed");
    expect(json).toContain("rv-human");
  } finally {
    api.task = originalTask;
  }
});

test("verdicts recorded for an older head are not shown against this one", async () => {
  const originalTask = api.task;
  api.task = (async (id: string) => verdictDetail(id, "older-head")) as typeof api.task;
  try {
    const renderer = await renderReview({ ...task("verdicts-stale"), head_sha: "head-1" });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("rv-confirmed");
  } finally {
    api.task = originalTask;
  }
});

// HIVE-403: the verification contract renders as a checklist on the card, with
// each satisfied command linked to its evidence file and the unproven ones
// marked, so the director sees what was actually run before shipping.
test("the review card renders the verification contract as a checklist", async () => {
  const originalTask = api.task;
  api.task = (async (id: string) => ({
    ...detail(id, "agent"),
    evidence: [
      {
        id: "ev-1",
        task_id: id,
        ts: "2026-01-01T00:00:00.000Z",
        kind: "test_run" as const,
        path: "/tmp/unit.txt",
        url: "http://hive/evidence/ev-1",
        caption: "unit run",
        meta: {},
      },
    ],
    verification: [
      { name: "unit", cmd: "bun test", satisfied: true, evidence_id: "ev-1" },
      { name: "typecheck", cmd: "bun run tsc --noEmit", satisfied: false, evidence_id: null },
    ],
  })) as typeof api.task;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree(task("verify-card")));
    });

    const rows = renderer.root.findAll((n) => n.type === "li" && String(n.props.className ?? "").startsWith("verify-"));
    expect(rows).toHaveLength(2);
    expect(rows[0].props.className).toBe("verify-ok");
    expect(rows[1].props.className).toBe("verify-missing");

    // The satisfied one links to its evidence file; the missing one says so.
    const link = renderer.root.findAll((n) => n.type === "a" && n.props.className === "verify-link")[0];
    expect(link.props.href).toBe("http://hive/evidence/ev-1");
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("typecheck");
    expect(rendered).toContain("no evidence");
    expect(rendered).toContain("1 of 2 unproven");
  } finally {
    api.task = originalTask;
  }
});

test("a task with no verification contract renders no checklist", async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(tree(task("no-contract")));
  });
  expect(renderer.root.findAll((n) => n.props?.className === "review-verify")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// HIVE-570. The risk check runs when the PR reaches review, so the card knows
// before it asks the director for anything whether Ship can work. It used to ask
// for the quiz first and refuse the merge afterwards.

// An unreviewed detail: no review_summary at all, so the ONLY reason the quiz
// could be hidden here is the confirmed risk, not a passed or missing check.
function riskyDetail(id: string): TaskDetail {
  return {
    ...task(id, "agent"),
    head_sha: "abc1234def",
    events: [
      {
        id: "auto-1",
        task_id: id,
        ts: "2026-01-01T00:00:00.000Z",
        source: "system",
        type: "auto_review",
        payload: { verdict: "caution", risks: ["a leak"], questions: [] },
      } as any,
      {
        id: "rv-1",
        task_id: id,
        ts: "2026-01-01T00:00:01.000Z",
        source: "system",
        type: "risk_verdicts",
        payload: { reviewed_head_sha: "abc1234def", verdicts: [{ risk: "a leak", verdict: "confirmed", why: "checked it" }] },
      } as any,
    ],
    evidence: [],
    decisions: [],
  };
}

async function renderWithConfirmedRisk(detailFor: (id: string) => TaskDetail) {
  const originalTask = api.task;
  const originalBranchCheck = api.branchCheck;
  api.task = (async (id: string) => detailFor(id)) as typeof api.task;
  api.branchCheck = (async () => ({
    unmet_deps: [],
    embedded_tasks: [],
    confirmed_risks: [{ risk: "a leak", why: "checked it" }],
    risk_check_unfinished: null,
  })) as typeof api.branchCheck;
  let renderer!: ReturnType<typeof create>;
  try {
    const t = { ...task("risky"), head_sha: "abc1234def" };
    await act(async () => {
      renderer = create(tree(t));
    });
  } finally {
    api.task = originalTask;
    api.branchCheck = originalBranchCheck;
  }
  return renderer;
}

const buttonNamed = (renderer: ReturnType<typeof create>, label: string) =>
  renderer.root.findAll((n) => n.type === "button" && n.children.includes(label));

test("a confirmed risk disables Approve & merge and says which risk (HIVE-570)", async () => {
  const renderer = await renderWithConfirmedRisk(riskyDetail);
  const merge = buttonNamed(renderer, "Approve & merge")[0];
  expect(merge.props.disabled).toBe(true);
  expect(merge.props.title).toContain("a leak");
  // Overriding is still possible, and its button is not disabled by the very
  // block it exists to override.
  const anyway = buttonNamed(renderer, "Merge anyway");
  expect(anyway).toHaveLength(1);
  expect(anyway[0].props.disabled).toBe(false);
});

test("a confirmed risk means no understanding check is asked (HIVE-570)", async () => {
  const renderer = await renderWithConfirmedRisk(riskyDetail);
  expect(renderer.root.findAllByType(UnderstandingQuiz)).toHaveLength(0);
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("not ready");
  // And it must not be mislabelled as a mechanical change with no check needed.
  expect(text).not.toContain("Mechanical change");
});

test("a risk found after a passed quiz says the answer was kept (HIVE-570)", async () => {
  const late = (id: string): TaskDetail => {
    const risky = riskyDetail(id);
    const passed = passingDetail(id);
    return { ...risky, events: [...passed.events, ...risky.events] };
  };
  const renderer = await renderWithConfirmedRisk(late);
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("You passed the understanding check on this change earlier");
  expect(text).toContain("abc1234");
  expect(text).toContain("your answer is kept");
});

test("the risk verdicts stay on the card so the finding is readable (HIVE-570)", async () => {
  const renderer = await renderWithConfirmedRisk(riskyDetail);
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain("a leak");
  expect(text).toContain("confirmed");
});

test("Merge anyway re-opens the check it silenced instead of dead-ending (HIVE-570)", async () => {
  // The server still refuses a merge whose understanding check is owed, so the
  // override has to bring the check back rather than merge straight past it.
  const originalTask = api.task;
  const originalBranchCheck = api.branchCheck;
  const merges: unknown[][] = [];
  const originalMerge = api.merge;
  api.task = (async (id: string) => riskyDetail(id)) as typeof api.task;
  api.branchCheck = (async () => ({
    unmet_deps: [],
    embedded_tasks: [],
    confirmed_risks: [{ risk: "a leak", why: "checked it" }],
    risk_check_unfinished: null,
  })) as typeof api.branchCheck;
  api.merge = (async (...args: unknown[]) => {
    merges.push(args);
    return {} as never;
  }) as typeof api.merge;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree({ ...task("risky-override"), head_sha: "abc1234def" }));
    });

    await act(async () => {
      buttonNamed(renderer, "Merge anyway")[0].props.onClick();
    });

    // No merge was attempted; the check is back and says why.
    expect(merges).toHaveLength(0);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("You chose to merge despite the confirmed risks");
    // Ship is now gated on the check, not on the risk.
    const merge = buttonNamed(renderer, "Approve & merge")[0];
    expect(merge.props.title).not.toContain("a leak");
  } finally {
    api.task = originalTask;
    api.branchCheck = originalBranchCheck;
    api.merge = originalMerge;
  }
});

// HIVE-557: the card that started the redesign. One refuted finding, one
// question only the director can answer, and a review line carrying the
// before/after state.
const HIVE_554_WHY =
  "Diagnosed why 7 rows were still stranded despite v39 already running: source is settable through the task-create API body, so rows created after v39 were never touched.";

function focusDetail(id: string): TaskDetail {
  return {
    ...task(id, "agent"),
    head_sha: "sha1",
    events: [
      {
        id: "rev-1",
        task_id: id,
        ts: "2026-01-01T00:00:00.000Z",
        source: "agent",
        type: "review_summary",
        payload: {
          done: [HIVE_554_WHY, "Verified on a copy of the live DB: stranded-row count 7 -> 0."],
          iffy: [{ what: "Applied the migration SQL directly to the live database.", why: "A restart needs a decision." }],
        },
      } as any,
      {
        id: "ar-1",
        task_id: id,
        ts: "2026-01-01T00:00:01.000Z",
        source: "system",
        type: "auto_review",
        payload: { verdict: "looks_good", summary: "Adds migration v45 to server/src/db.ts, a re-run of v39's guard." },
      } as any,
      {
        id: "rv-1",
        task_id: id,
        ts: "2026-01-01T00:00:02.000Z",
        source: "system",
        type: "risk_verdicts",
        payload: {
          reviewed_head_sha: "sha1",
          verdicts: [{ verdict: "refuted", risk: "the count gap is unexplained", why: "set-based migration" }],
          question_verdicts: [{ answerable: "human", question: "Can you confirm the live DB shows zero stranded rows?" }],
        },
      } as any,
    ],
    evidence: [],
    decisions: [],
  };
}

test("the card leads with what changed and its recommendation agrees with the open question (HIVE-557)", async () => {
  const originalTask = api.task;
  const originalBranchCheck = api.branchCheck;
  api.task = (async (id: string) => focusDetail(id)) as typeof api.task;
  api.branchCheck = (async () => ({
    unmet_deps: [],
    embedded_tasks: [],
    understanding_required: false,
    confirmed_risks: [],
  })) as typeof api.branchCheck;
  try {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(tree({ ...task("focus-557"), head_sha: "sha1" }));
    });
    const text = JSON.stringify(renderer.toJSON());

    // 1. what changed, from hive's own pre-review of the diff
    expect(text).toContain("What changed");
    expect(text).toContain("Adds migration v45");
    // 2. before → after, as a table
    expect(text).toContain("Before → after");
    expect(text).toContain("stranded-row count");
    // 3. why, pulled from the line that explains the cause
    expect(text).toContain("Why it was needed");
    // 4. the recommendation cannot say "approve and merge" over an open question
    expect(text).toContain("Answer the open question, then merge");
    expect(text).not.toContain("Approve and merge</strong>");
    // 5. the refuted finding is a count, not a paragraph above the open one
    expect(text).toContain("Pre-review checked ");
    // 6. and nothing the lead already said is repeated lower down
    expect(text.split(HIVE_554_WHY.slice(0, 60)).length - 1).toBe(1);
  } finally {
    api.task = originalTask;
    api.branchCheck = originalBranchCheck;
  }
});
