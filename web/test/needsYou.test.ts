import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Checkpoint, Decision, Task, UnderstandingQuiz } from "../src/lib/api";
import { getNeedsYouItems } from "../src/lib/needsYou";
import { JiraPanel, jiraMoveHint, jiraMoveSummary, jiraNextAutomaticText, jiraPanelNotice, trackingBindingNotice } from "../src/views/Task";

const task = (id: string, state: Task["state"], extra: Partial<Task> = {}) => ({ id, state, ...extra }) as Task;

test("needs-you queue includes every actionable item", () => {
  const decision = { id: "decision-1" } as Decision;
  const checkpoint = { id: "checkpoint-1" } as Checkpoint;
  const quiz = { id: "quiz-1", task_id: "quiz-task", task_state: "in_review" } as UnderstandingQuiz;
  const activeQuiz = { id: "quiz-active", task_id: "review-1", task_state: "done" } as UnderstandingQuiz;
  const cancelledQuiz = { id: "quiz-cancelled", task_id: "cancelled-1", task_state: "in_review" } as UnderstandingQuiz;
  const items = getNeedsYouItems(
    [decision],
    [
      task("review-1", "in_review", { health: { status: "dead", reason: null, since: "now" } }),
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

  expect(items.map((item) => item.kind)).toEqual(["decision", "checkpoint", "quiz", "review", "attention", "attention"]);
  expect(items.map((item) => item.id)).toEqual(["decision-1", "checkpoint-1", "quiz-1", "review-1", "failed-1", "stuck-1"]);
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

test("reviews with pending CI do not hide actionable reviews", () => {
  const items = getNeedsYouItems(
    [],
    [
      task("pending", "in_review", { kind: "ship", pr_url: "https://example.com/pending", ci_status: "pending" }),
      ...[1, 2, 3, 4].map((number) => task(`ready-${number}`, "in_review", {
        kind: "ship",
        pr_url: `https://example.com/ready-${number}`,
        ci_status: "passing",
      })),
    ],
    [],
    []
  );

  expect(items.map((item) => item.id)).toEqual(["ready-1", "ready-2", "ready-3", "ready-4", "pending"]);
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
      browse_url: "https://corebeat.atlassian.net/browse/WEB-1",
      configured: false,
    },
    onSynced: () => {},
  }));

  expect(html).toContain('href="https://corebeat.atlassian.net/browse/WEB-1"');
  expect(html).toContain("unconfigured");
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
