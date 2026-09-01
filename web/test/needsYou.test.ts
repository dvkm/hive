import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Checkpoint, Decision, Task, UnderstandingQuiz } from "../src/lib/api";
import { getNeedsYouItems, isInMotion, itemProject, orderFocusItems, trackedSubtasks } from "../src/lib/needsYou";
import { inProjectFilter } from "../src/lib/projectFilter";
import { JiraPanel, jiraMoveHint, jiraMoveSummary, jiraNextAutomaticText, jiraPanelNotice, trackingBindingNotice } from "../src/views/Task";

const task = (id: string, state: Task["state"], extra: Partial<Task> = {}) => ({ id, state, ...extra }) as Task;

test("tracked Jira cards show logical subtasks with retry chains collapsed", () => {
  const tracked = task("jira", "in_review", {
    project_id: "acme",
    title: "[WEB-7] Newsletter",
    source: "external",
    source_ref: "jira:WEB-7",
  });
  const shipped = task("shipped", "done", {
    project_id: "acme",
    title: "[WEB-7] Analytics",
    parent_task_id: "manager",
    updated_at: "2026-08-20T00:00:00Z",
  });
  const failed = task("failed", "failed", {
    project_id: "acme",
    title: "[WEB-7] Autosave",
    parent_task_id: "manager",
    updated_at: "2026-08-19T00:00:00Z",
  });
  const retry = task("retry", "in_progress", {
    project_id: "acme",
    title: failed.title,
    source: "requeue",
    parent_task_id: failed.id,
    updated_at: "2026-08-21T00:00:00Z",
  });
  const otherIssue = task("other", "done", {
    project_id: "acme",
    title: "[WEB-6] Intro",
    updated_at: "2026-08-21T00:00:00Z",
  });

  expect(trackedSubtasks(tracked, [tracked, shipped, failed, retry, otherIssue]).map((candidate) => candidate.id)).toEqual([
    "retry",
    "shipped",
  ]);
});

test("needs-you queue includes every actionable item", () => {
  const decision = { id: "decision-1" } as Decision;
  const checkpoint = { id: "checkpoint-1" } as Checkpoint;
  const quiz = { id: "quiz-1", task_id: "quiz-task", project_id: "p1", task_state: "in_review" } as UnderstandingQuiz;
  const activeQuiz = { id: "quiz-active", task_id: "review-1", task_state: "done" } as UnderstandingQuiz;
  const cancelledQuiz = { id: "quiz-cancelled", task_id: "cancelled-1", task_state: "in_review" } as UnderstandingQuiz;
  const items = getNeedsYouItems(
    [decision],
    [
      task("review-1", "in_review", { review_actionable: true, health: { status: "dead", reason: null, since: "now" } }),
      task("failed-1", "failed"),
      task("requeued-1", "failed", { requeued_to: "successor" }),
      task("stuck-1", "in_progress", { health: { status: "stuck", reason: null, since: "now" } }),
      task("manager-1", "in_progress", { source: "chat_supervisor", health: { status: "stuck", reason: null, since: "now" } }),
      task("tracked-1", "failed", { source: "external" }),
      task("quiz-task", "done"),
      task("cancelled-1", "cancelled"),
    ],
    [checkpoint],
    [quiz, activeQuiz, cancelledQuiz]
  );

  expect(items.map((item) => item.kind)).toEqual(["decision", "checkpoint", "quiz_digest", "review", "attention", "attention"]);
  expect(items.map((item) => item.id)).toEqual(["decision-1", "checkpoint-1", "quiz-digest:p1", "review-1", "failed-1", "stuck-1"]);
});

test("a stuck/dead task blocked on an unmerged dependency is 'waiting', not 'attention', and contributes no attention item", () => {
  const blocker = task("blocker-1", "in_progress", { number: 87, title: "Consolidate the external-task guard", pr_url: "https://example.com/pull/87" });
  const stuck = task("stuck-1", "in_progress", { number: 993, title: "Reject undeliverable sends", depends_on: ["blocker-1"], health: { status: "stuck", reason: null, since: "now" } });
  const items = getNeedsYouItems([], [blocker, stuck], [], []);

  expect(items).toEqual([
    {
      kind: "waiting",
      id: "stuck-1",
      task: stuck,
      blockedBy: [{ id: "blocker-1", number: 87, title: "Consolidate the external-task guard", state: "in_progress", pr_url: "https://example.com/pull/87" }],
    },
  ]);
});

test("a dependency landing (verifying/done) moves its dependent from 'waiting' back to 'attention'", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("blocker-1", "verifying", { number: 87, title: "Consolidate the external-task guard" }),
      task("stuck-1", "in_progress", { depends_on: ["blocker-1"], health: { status: "stuck", reason: null, since: "now" } }),
    ],
    [],
    []
  );

  expect(items.map((item) => item.kind)).toEqual(["attention"]);
});

test("a task blocked only by dead dependencies needs attention instead of waiting", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("failed-blocker", "failed"),
      task("cancelled-blocker", "cancelled"),
      task("wedged", "queued", {
        depends_on: ["failed-blocker", "cancelled-blocker"],
        health: { status: "stuck", reason: "all blocking dependencies ended without completing", since: "now" },
      }),
    ],
    [],
    []
  );

  expect(items.map((item) => ({ id: item.id, kind: item.kind }))).toContainEqual({ id: "wedged", kind: "attention" });
});

test("a failed task always needs routing, even with an unmet dependency", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("blocker-1", "in_progress", { number: 87, title: "Still in flight" }),
      task("failed-1", "failed", { depends_on: ["blocker-1"] }),
    ],
    [],
    []
  );

  expect(items.map((item) => item.kind)).toEqual(["attention"]);
});

// HIVE-500: a review the director cannot act on yet is still listed, but as its
// own kind, so no count and no focus card ever stops on it.
test("reviews the director cannot act on split into review_pending", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("pending", "in_review", { kind: "ship", pr_url: "https://example.com/pending", ci_status: "pending" }),
      task("no-report", "in_review", { kind: "ship" }),
      ...[1, 2].map((number) => task(`ready-${number}`, "in_review", {
        kind: "ship",
        pr_url: `https://example.com/ready-${number}`,
        ci_status: "passing",
        review_actionable: true,
      })),
    ],
    [],
    []
  );

  expect(items.map((item) => [item.id, item.kind])).toEqual([
    ["pending", "review_pending"],
    ["no-report", "review_pending"],
    ["ready-1", "review"],
    ["ready-2", "review"],
  ]);
});

test("Focus gives priority a head start without starving old low-priority work", () => {
  const tasks = [
    task("old-later", "in_review", { priority: "later", needs_you_since: "2026-08-20T00:00:00Z", updated_at: "2026-08-24T00:00:00Z" }),
    task("new-now", "in_review", { priority: "now", updated_at: "2026-08-23T00:00:00Z" }),
    task("new-normal", "in_review", { priority: "normal", updated_at: "2026-08-24T00:00:00Z" }),
    task("new-later", "in_review", { priority: "later", updated_at: "2026-08-24T00:00:00Z" }),
  ];
  const items = [
    { kind: "review" as const, id: tasks[0].id, task: tasks[0] },
    { kind: "decision" as const, id: "decision-now", decision: { id: "decision-now", task_id: tasks[1].id, ts: tasks[1].updated_at } as Decision },
    { kind: "checkpoint" as const, id: "checkpoint-normal", checkpoint: { id: "checkpoint-normal", task_id: tasks[2].id, ts: tasks[2].updated_at } as Checkpoint },
    { kind: "review" as const, id: tasks[3].id, task: tasks[3] },
  ];

  expect(orderFocusItems(items, tasks).map((item) => item.id)).toEqual([
    "old-later",
    "decision-now",
    "checkpoint-normal",
    "new-later",
  ]);
});

test("tracking-only tasks never enter code-review queues", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("jira", "in_review", { source: "external", source_ref: "jira:WEB-1" }),
      task("linked", "in_review", { source: "agent", source_ref: "jira:WEB-2" }),
      task("canary-1", "in_review", { source: "external", never_dispatched: true }),
      task("review", "in_review", { source: "agent", pr_url: "https://example.com/pr", ci_status: "passing" }),
    ],
    [],
    []
  );

  expect(items.map((item) => item.id)).toEqual(["review"]);
});

test("Jira move hints distinguish mapped, label-only, Hive-only, and shadow outcomes", () => {
  const live = { linked: true, configured: true, enabled: true, write: true };
  expect(jiraMoveHint("queued", "in_progress", live)).toContain("sets Jira to In Progress");
  expect(jiraMoveHint("in_progress", "needs_decision", live)).toContain("keeps its status and gains the needs-decision label");
  expect(jiraMoveHint("in_progress", "failed", live)).toContain("Hive only; Jira will not change");
  expect(jiraMoveHint("in_review", "verifying", live)).toContain("Jira stays at In Review");
  const shadowNoop = jiraMoveHint("in_review", "verifying", { ...live, write: false });
  expect(shadowNoop).toContain("Jira stays at In Review");
  expect(shadowNoop).not.toContain("logs Jira status");
  expect(jiraMoveHint("verifying", "done", { ...live, write: false })).toContain("shadow mode logs Jira status Done but does not send it");
  expect(jiraMoveHint("needs_decision", "in_progress", live)).toContain("keeps its status and removes the needs-decision label");
  expect(jiraMoveHint("needs_decision", "cancelled", live)).toContain("keeps its status and removes the needs-decision label");
  expect(jiraMoveHint("needs_decision", "in_progress", { ...live, write: false })).toContain("logs removal of the Jira needs-decision label but does not send it");
});

test("Jira move hints do not promise live writes while sync is unavailable", () => {
  expect(jiraMoveHint("verifying", "done", null)).toContain("still loading");
  expect(jiraMoveHint("verifying", "done", { linked: true, configured: false })).toContain("unconfigured or not allow-listed");
  expect(jiraMoveHint("verifying", "done", { linked: true, configured: true, enabled: false, write: false })).toContain("paused");
});

test("Jira move summaries include the current state's label effect", () => {
  const live = { linked: true, configured: true, enabled: true, write: true };
  expect(jiraMoveSummary("in_progress", live)).toContain("Failed and Cancelled stay Hive-only");
  expect(jiraMoveSummary("needs_decision", live)).toContain("every move out of Needs decision also removes its Jira label");
  expect(jiraMoveSummary("needs_decision", { ...live, write: false })).toContain("logs removal of the Jira needs-decision label");
});

test("Jira panel copy distinguishes unavailable, paused, shadow, and live sync", () => {
  expect(jiraPanelNotice(null)).toContain("still loading");
  expect(jiraPanelNotice({ linked: true, configured: false })).toContain("unconfigured");
  expect(jiraPanelNotice({ linked: true, configured: true, enabled: false, write: false })).toContain("paused");
  expect(jiraPanelNotice({ linked: true, configured: true, enabled: true, write: false })).toContain("Shadow mode");
  expect(jiraPanelNotice({ linked: true, configured: true, enabled: true, write: true })).toBeNull();
});

test("Jira next-run copy uses the shared availability mode", () => {
  expect(jiraNextAutomaticText(null)).toBe("sync state loading");
  expect(jiraNextAutomaticText({ linked: true, configured: false })).toBe("not configured");
  expect(jiraNextAutomaticText({ linked: true, configured: true, enabled: false })).toBe("paused (sync disabled)");
  expect(jiraNextAutomaticText({ linked: true, configured: true, enabled: true, write: true })).toBe("—");
});

test("the Jira panel surfaces contained delivery uncertainty with one-click resolution", () => {
  const html = renderToStaticMarkup(createElement(JiraPanel, {
    task: { id: "jira-task", source_ref: "jira:WEB-1" } as any,
    jira: {
      linked: true,
      issue_key: "WEB-1",
      configured: true,
      enabled: true,
      write: true,
      pending: {
        comments: 1,
        receipts: 0,
        unknown: [{
          action: "comment_push",
          source_id: "evt-1",
          error: "request timed out",
          text: "maybe landed",
          ts: "2026-01-01T00:00:00.000Z",
        }],
      },
      delivered: [],
    },
    onSynced: () => {},
  }));

  expect(html).toContain("Delivery outcome unknown");
  expect(html).toContain("will not retry");
  expect(html).toContain("maybe landed");
  expect(html).toContain("I checked Jira · resolve");
});

test("the Jira panel keeps the safe browse action when sync is unconfigured", () => {
  const html = renderToStaticMarkup(createElement(JiraPanel, {
    task: { id: "jira-task", source_ref: "jira:WEB-1" } as any,
    jira: {
      linked: true,
      issue_key: "WEB-1",
      browse_url: "https://example.atlassian.net/browse/WEB-1",
      configured: false,
    },
    onSynced: () => {},
  }));

  expect(html).toContain('href="https://example.atlassian.net/browse/WEB-1"');
  expect(html).toContain("unconfigured");
});

test("the Jira panel names an invalid config on the first read, before anything has failed", () => {
  // The automatic cycle is off for a config the server refused, so waiting for a
  // failure count would leave the director reading "not configured" and hunting
  // for a setup that is actually there but broken.
  const jira = {
    linked: true,
    issue_key: "WEB-1",
    configured: false,
    config_error: 'config.jira.jql is invalid: "labels = sync) OR project = OPS"',
    sync: { consecutive_failures: 0, last_error: null, next_due_at: null },
  } as any;
  const html = renderToStaticMarkup(createElement(JiraPanel, {
    task: { id: "jira-task", source_ref: "jira:WEB-1" } as any,
    jira,
    onSynced: () => {},
  }));

  expect(html).toContain("Jira config invalid");
  expect(html).toContain("config.jira.jql is invalid");
  expect(html).toContain("The automatic sync is off until this is fixed");
  expect(html).not.toContain("consecutive failure");
  expect(html).not.toContain("unconfigured or not allow-listed");
  expect(jiraNextAutomaticText(jira)).toBe("off (config invalid)");
  expect(jiraPanelNotice(jira)).toBeNull();
  expect(jiraMoveHint("verifying", "done", jira)).toContain("the Jira config is invalid");
  expect(jiraMoveSummary("verifying", jira)).toContain("The Jira config is invalid");
});

test("legacy tracking bindings remain visibly actionable", () => {
  const jira = task("legacy", "in_progress", {
    source: "external",
    source_ref: "jira:WEB-OLD",
    agent_target: "legacy-agent",
    worktree_path: "/repo/.worktrees/legacy",
  }) as any;
  expect(trackingBindingNotice(jira)).toContain("/repo/.worktrees/legacy");
  expect(trackingBindingNotice(task("ordinary", "in_progress") as any)).toBeNull();
});

test("itemProject resolves the project for every needs-you item kind", () => {
  const reviewTask = task("t-review", "in_review", { project_id: "p1", pr_url: "https://x/1", ci_status: "passing", review_actionable: true });
  const decisionTask = task("t-decision", "needs_decision", { project_id: "p2" });
  const tasks = [reviewTask, decisionTask];
  const decision = { id: "d1", task_id: "t-decision", status: "open" } as Decision;
  const checkpoint = { id: "c1", task_id: "t-x", project_id: "p3" } as Checkpoint;
  const quiz = { id: "q1", task_id: "t-y", project_id: "p4", task_state: "verifying" } as UnderstandingQuiz;

  const items = getNeedsYouItems([decision], tasks, [checkpoint], [quiz]);
  const projects = Object.fromEntries(items.map((item) => [item.kind, itemProject(item, tasks)]));
  expect(projects).toEqual({ decision: "p2", checkpoint: "p3", quiz_digest: "p4", review: "p1" });

  // "All" (empty filter) keeps everything; a project filter keeps only its own.
  expect(items.filter((item) => inProjectFilter(itemProject(item, tasks), "")).length).toBe(4);
  expect(items.filter((item) => inProjectFilter(itemProject(item, tasks), "p2")).map((item) => item.kind)).toEqual(["decision"]);
});

// HIVE-541: the "N in motion" count on the Chat view used to total every task in
// a work column, so mirrored tickets parked there read as work being done.
test("in motion counts hive's own work, not tracking-only rows parked in a work column", () => {
  const own = task("own", "in_progress");
  const mirror = task("mirror", "in_progress", { source: "director", source_ref: "jira:WEB-7" });
  const external = task("external", "in_review", { source: "external" });
  const spawnedExternal = task("spawned", "in_progress", { source: "external", agent_target: "claude" });
  const supervisor = task("chief", "in_progress", { source: "chat_supervisor" });
  const queued = task("queued", "queued");

  expect([own, mirror, external, spawnedExternal, supervisor, queued].filter(isInMotion).map((t) => t.id)).toEqual([
    "own",
    "spawned",
  ]);
});
