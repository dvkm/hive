import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Decision, Intent, Task } from "../src/lib/api";
import { actionableItems, getNeedsYouItems, isInMotion, itemProject, mirrorStillWorking, orderFocusItems, trackedSubtasks } from "../src/lib/needsYou";
import { inProjectFilter } from "../src/lib/projectFilter";
import { JiraPanel, jiraMoveHint, jiraMoveSummary, jiraPanelNotice, trackingBindingNotice } from "../src/views/Task";

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

// The server marks a review the director's by its gate; review_actionable is
// the same fact (health.ts sets it to review_gate === "needs_you").
const yours = { review_gate: "needs_you", review_actionable: true } as const;

const intent = (id: string, extra: Partial<Intent> = {}) =>
  ({ id, project_id: "p1", task_id: null, status: "draft", body_md: "", updated_at: "2026-09-01T00:00:00Z", ...extra }) as Intent;

test("needs you holds only decisions, draft asks, and reviews that wait for a Ship", () => {
  const items = getNeedsYouItems(
    [{ id: "decision-1" } as Decision],
    [
      task("review-1", "in_review", { ...yours, health: { status: "dead", reason: null, since: "now" } }),
      task("failed-1", "failed"),
      task("stuck-1", "in_progress", { health: { status: "stuck", reason: null, since: "now" } }),
      task("merged-1", "verifying", { pr_url: "https://example.com/pull/1" }),
      task("done-1", "done"),
    ],
    [intent("intent-1"), intent("accepted-1", { status: "accepted" })]
  );

  // Stuck, failed and merged work is hive's: the digest reports it.
  expect(items.map((item) => [item.kind, item.id])).toEqual([
    ["decision", "decision-1"],
    ["intent", "intent-1"],
    ["review", "review-1"],
  ]);
});

test("a decision the advisor has not handed to the director stays out", () => {
  const items = getNeedsYouItems(
    [
      { id: "judging", for_director: false } as Decision,
      { id: "yours", for_director: true } as Decision,
      { id: "older-server" } as Decision,
    ],
    []
  );
  expect(items.map((item) => item.id)).toEqual(["yours", "older-server"]);
});

test("a draft ask stays out while hive is still reading the code or waiting on the reporter", () => {
  const items = getNeedsYouItems(
    [],
    [],
    [
      intent("reading", { hive_working: true }),
      intent("asked-reporter", { waiting_on: "reporter" }),
      intent("yours", { hive_working: false, waiting_on: null }),
    ]
  );
  expect(items.map((item) => item.id)).toEqual(["yours"]);
});

// HIVE-500: a review the director cannot act on yet stays on the board, but
// never counts as needing him.
test("an in_review task needs you only when its review gate is needs_you", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("merging", "in_review", { review_gate: "hive_merging", review_actionable: false, ci_status: "passing" }),
      task("pending", "in_review", { review_gate: "ci_pending", review_actionable: false, ci_status: "pending" }),
      task("no-report", "in_review", { review_gate: "no_pr", review_actionable: false }),
      task("ready", "in_review", { ...yours, review_hold: "It changes billing." }),
    ]
  );

  expect(items.map((item) => [item.id, item.kind])).toEqual([["ready", "review"]]);
});

// A mirror rides one column behind its work: while any work task under it is
// live, the work task's card is the one that carries the ticket.
test("a Jira mirror counts as still working while any of its work tasks is live", () => {
  const mirror = task("mirror", "in_review", { source: "external", source_ref: "jira:ABC-10", jira_key: "ABC-10" });
  const work = task("work", "in_progress", { jira_mirror_task_id: "mirror" });
  expect(mirrorStillWorking(mirror, [mirror, work])).toBe(true);
  expect(mirrorStillWorking(mirror, [mirror, { ...work, state: "done" }])).toBe(false);
  // Only a mirror rides behind work; an ordinary task never does.
  expect(mirrorStillWorking(work, [mirror, work])).toBe(false);
});

test("the queue gives priority a head start without starving old low-priority work", () => {
  const tasks = [
    task("old-later", "in_review", { priority: "later", needs_you_since: "2026-08-20T00:00:00Z", updated_at: "2026-08-24T00:00:00Z" }),
    task("new-now", "in_review", { priority: "now", updated_at: "2026-08-23T00:00:00Z" }),
    task("new-normal", "in_review", { priority: "normal", updated_at: "2026-08-24T00:00:00Z" }),
    task("new-later", "in_review", { priority: "later", updated_at: "2026-08-24T00:00:00Z" }),
  ];
  const items = [
    { kind: "review" as const, id: tasks[0].id, task: tasks[0] },
    { kind: "decision" as const, id: "decision-now", decision: { id: "decision-now", task_id: tasks[1].id, ts: tasks[1].updated_at } as Decision },
    { kind: "review" as const, id: tasks[2].id, task: tasks[2] },
    { kind: "review" as const, id: tasks[3].id, task: tasks[3] },
  ];

  expect(orderFocusItems(items, tasks).map((item) => item.id)).toEqual([
    "old-later",
    "decision-now",
    "new-normal",
    "new-later",
  ]);
});

test("tracking-only tasks never enter code-review queues", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("jira", "in_review", { ...yours, source: "external", source_ref: "jira:WEB-1" }),
      task("linked", "in_review", { ...yours, source: "agent", source_ref: "jira:WEB-2" }),
      task("canary-1", "in_review", { ...yours, source: "external", never_dispatched: true }),
      task("review", "in_review", { ...yours, source: "agent", pr_url: "https://example.com/pr", ci_status: "passing" }),
    ]
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
  const reviewTask = task("t-review", "in_review", { project_id: "p1", pr_url: "https://x/1", ci_status: "passing", ...yours });
  const decisionTask = task("t-decision", "needs_decision", { project_id: "p2" });
  const tasks = [reviewTask, decisionTask];
  const decision = { id: "d1", task_id: "t-decision", status: "open" } as Decision;

  const items = getNeedsYouItems([decision], tasks, [intent("i1", { project_id: "p3" })]);
  const projects = Object.fromEntries(items.map((item) => [item.kind, itemProject(item, tasks)]));
  expect(projects).toEqual({ decision: "p2", intent: "p3", review: "p1" });

  // "All" (empty filter) keeps everything; a project filter keeps only its own.
  expect(items.filter((item) => inProjectFilter(itemProject(item, tasks), "")).length).toBe(3);
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

// HIVE-556. The nav badge and the Home headline both call actionableItems, so
// "needs you" can only ever mean one thing. This test is what fails if another
// surface starts counting its own set again.
test("one needs-you count: pending reviews and stuck agents never count, and the project filter applies", () => {
  const mine = task("mine", "in_review", { project_id: "acme", ...yours });
  const notMine = task("theirs", "in_review", { project_id: "other", ...yours });
  const pending = task("pending", "in_review", { project_id: "acme", review_gate: "review_running", review_actionable: false });
  const stuck = task("stuck", "in_progress", {
    project_id: "acme",
    health: { status: "stuck", since: "2026-01-01T00:00:00Z", reason: "quiet" },
  });
  const tasks = [mine, notMine, pending, stuck];
  const items = getNeedsYouItems([{ id: "d1", task_id: "mine" } as Decision], tasks);

  // Across every project: the decision and the two reviews waiting for a Ship.
  expect(actionableItems(items, tasks).map((item) => item.id).sort()).toEqual(["d1", "mine", "theirs"]);
  // Scoped to one project, the other project's review drops out.
  expect(actionableItems(items, tasks, "acme").map((item) => item.id).sort()).toEqual(["d1", "mine"]);
});
