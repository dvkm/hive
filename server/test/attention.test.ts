// The attention budget: the count, the threshold, and the two optional
// generators that stop while the director is over budget.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-attention-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
import type { DB } from "../src/db.ts";
const { attentionBudget, attentionThreshold, setAttentionThreshold, overAttentionBudget, ATTENTION_BUDGET_DEFAULT } =
  await import("../src/attention.ts");
const { checkWatcher, heldWatchChanges } = await import("../src/watch.ts");
const { dispatchOnce } = await import("../src/dispatcher.ts");
const { getTask } = await import("../src/state.ts");
const { Herdr } = await import("../src/runtime/herdr.ts");
import type { Exec } from "../src/exec.ts";

function freshDb(config: any = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", JSON.stringify(config), now());
  return { db, projectId };
}

function makeTask(db: DB, projectId: string, extra: Partial<{ kind: string; state: string; source: string }> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, projectId, "t", null, extra.state ?? "queued", extra.kind ?? "ship", extra.source ?? null, t, t);
  return id;
}

// Open decision cards are the simplest actionable item there is: one card, one
// thing waiting on the director.
function openDecisions(db: DB, projectId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const taskId = makeTask(db, projectId, { state: "needs_decision" });
    db.query("INSERT INTO decisions (id, task_id, ts, title, status) VALUES (?,?,?,?,'open')")
      .run(newId("dec"), taskId, now(), `question ${i}`);
  }
}

const fetchBody = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
const watchTasks = (db: DB) => db.query("SELECT * FROM tasks WHERE source = 'watch'").all() as any[];
const W = { name: "spec", url: "https://example.com/spec", prompt: "sync the roadmap page" };

test("the default threshold is 5 and an empty queue is never over budget", () => {
  const { db } = freshDb();
  expect(attentionThreshold(db)).toBe(ATTENTION_BUDGET_DEFAULT);
  const budget = attentionBudget(db);
  expect(budget).toMatchObject({ count: 0, threshold: 5, over: false, paused: [] });
});

test("the count is the open decisions, and it goes over budget at threshold + 1", () => {
  const { db, projectId } = freshDb();
  openDecisions(db, projectId, 5);
  expect(attentionBudget(db)).toMatchObject({ count: 5, over: false });

  openDecisions(db, projectId, 1);
  const over = attentionBudget(db);
  expect(over.count).toBe(6);
  expect(over.over).toBe(true);
  expect(over.paused).toEqual(["new scouts", "watcher tasks"]);
});

test("threshold 0 turns the budget off entirely", () => {
  const { db, projectId } = freshDb();
  openDecisions(db, projectId, 20);
  setAttentionThreshold(db, 0);
  expect(attentionThreshold(db)).toBe(0);
  expect(overAttentionBudget(db)).toBe(false);
});

test("a raised threshold lets more through before anything pauses", () => {
  const { db, projectId } = freshDb();
  openDecisions(db, projectId, 8);
  expect(overAttentionBudget(db)).toBe(true);
  setAttentionThreshold(db, 10);
  expect(overAttentionBudget(db)).toBe(false);
});

test("over budget a watcher change is HELD, not dropped: it is filed in full once the queue drains", async () => {
  const { db, projectId } = freshDb();
  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("v1\n") }); // baseline

  openDecisions(db, projectId, 6);
  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("v2\n") });
  expect(watchTasks(db)).toHaveLength(0);
  // The hold is recorded, so a quiet board can say work is being held rather
  // than looking like nothing happened.
  expect(heldWatchChanges(db)).toBe(1);
  expect(attentionBudget(db).held).toMatchObject({ watchers: 1 });

  // Queue drains: the change is still filed, once, and the diff covers
  // everything that happened while it was held (v1 -> v3, not v2 -> v3).
  db.query("UPDATE decisions SET status = 'answered'").run();
  await checkWatcher(db, projectId, W, { fetchImpl: fetchBody("v3\n") });
  const tasks = watchTasks(db);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].brief).toContain("-v1");
  expect(tasks[0].brief).toContain("+v3");
  expect(heldWatchChanges(db)).toBe(0);
});

// The spawn stub from dispatcher.test.ts, trimmed to what a successful spawn needs.
const WT = mkdtempSync(join(tmpdir(), "hive-attention-wt-"));
function stubHerdr() {
  const spawns: string[] = [];
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  const exec: Exec = async (argv) => {
    if (has(argv, "worktree", "create")) {
      spawns.push(argv[argv.indexOf("--cwd") + 1]);
      return { code: 0, stdout: `{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`, stderr: "" };
    }
    if (has(argv, "workspace", "list")) return { code: 0, stdout: '{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}', stderr: "" };
    if (has(argv, "tab", "create")) return { code: 0, stdout: '{"result":{"tab":{"tab_id":"wF:t2"}}}', stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { herdr: new Herdr(exec, "herdr"), spawns };
}

test("over budget, a queued scout waits and says why; ship work still dispatches", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  openDecisions(db, projectId, 6);
  const scout = makeTask(db, projectId, { kind: "scout" });
  const ship = makeTask(db, projectId, { kind: "ship" });

  await dispatchOnce(db, { herdr: stubHerdr().herdr });

  expect(getTask(db, scout).state).toBe("queued");
  expect(getTask(db, scout).skip_reason).toBe("attention_budget");
  expect(getTask(db, ship).state).toBe("in_progress");
  // Held, not dropped: the scout is still queued and the board can say so.
  expect(attentionBudget(db).held).toMatchObject({ scouts: 1 });
});

test("a held scout dispatches as soon as the queue drains", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  openDecisions(db, projectId, 6);
  const scout = makeTask(db, projectId, { kind: "scout" });
  await dispatchOnce(db, { herdr: stubHerdr().herdr });
  expect(getTask(db, scout).state).toBe("queued");

  db.query("UPDATE decisions SET status = 'answered'").run();
  await dispatchOnce(db, { herdr: stubHerdr().herdr });
  expect(getTask(db, scout).state).toBe("in_progress");
});

test("under budget, the same scout dispatches", async () => {
  const { db, projectId } = freshDb({ auto_dispatch: true });
  const scout = makeTask(db, projectId, { kind: "scout" });

  await dispatchOnce(db, { herdr: stubHerdr().herdr });

  expect(getTask(db, scout).state).toBe("in_progress");
});
