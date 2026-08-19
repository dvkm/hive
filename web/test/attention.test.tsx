import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { ReactElement } from "react";
import type { Task } from "../src/lib/api";
import { StoreProvider } from "../src/lib/store";
import { EditRequeueModal, FailedRow, UnhealthyRow } from "../src/views/attention";

function task(extra: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    number: 1,
    project_id: "project-1",
    title: "Ticket",
    brief: "Brief",
    state: "failed",
    kind: "ship",
    agent_target: null,
    worktree_path: null,
    branch: null,
    pr_url: null,
    ci_status: null,
    head_sha: null,
    summary: null,
    source: null,
    source_ref: null,
    parent_task_id: null,
    duplicate_of: null,
    depends_on: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

function renderRow(row: ReactElement): string {
  return renderToStaticMarkup(
    <StaticRouter location="/work">
      <StoreProvider>{row}</StoreProvider>
    </StaticRouter>
  );
}

test("attention rows suppress agent ownership actions for tracking-only tasks", () => {
  const jira = task({ source: "external", source_ref: "jira:WEB-1" });
  const failed = renderRow(<FailedRow task={jira} />);
  expect(failed).not.toContain("Requeue");
  expect(failed).not.toContain("Edit &amp; requeue");
  expect(renderToStaticMarkup(<EditRequeueModal task={jira} onClose={() => {}} />)).toBe("");

  const unhealthy = renderRow(
    <UnhealthyRow
      task={task({
        state: "in_progress",
        source: "external",
        source_ref: "jira:WEB-1",
        agent_target: "stale-agent",
        health: { status: "dead", reason: "gone", since: "2026-01-01T00:00:00.000Z" },
      })}
    />
  );
  expect(unhealthy).not.toContain("View agent");
  expect(unhealthy).not.toContain("Nudge");
  expect(unhealthy).not.toContain("Fail + requeue");

  const ordinary = renderRow(<FailedRow task={task()} />);
  expect(ordinary).toContain("Requeue");
  expect(ordinary).toContain("Edit &amp; requeue");
});
