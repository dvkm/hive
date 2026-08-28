import { test, expect } from "bun:test";
import { openDb, newId, now, type DB } from "../src/db.ts";
import { adoptUntrackedPr, retireAdoptedTasks, runPrGardener, DEFAULT_ADOPT_SKIP_LABELS, ADOPT_LIST_LIMIT } from "../src/prGardener.ts";
import { getTask } from "../src/state.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function freshDb(config: object = {}): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify({ default_branch: "main", ...config }), now()
  );
  return { db, projectId };
}

const PR = { number: 999, url: "https://github.com/acme/monorepo/pull/999", title: "Clean up dead config" };

test("adopts an untracked PR exactly once", () => {
  const { db, projectId } = freshDb();
  const first = adoptUntrackedPr(db, projectId, PR);
  expect(first.outcome).toBe("adopted");

  const task: any = getTask(db, first.task_id!);
  expect(task.pr_url).toBe(PR.url);
  expect(task.source).toBe("external"); // tracking-only: never spawned, never merged by hive
  expect(task.source_ref).toBe("pr-adopt:999");
  expect(task.state).toBe("queued");

  // Same PR on the next sweep: recognised, not duplicated.
  const second = adoptUntrackedPr(db, projectId, PR);
  expect(second.outcome).toBe("tracked");
  expect(second.task_id).toBe(first.task_id);
  expect((db.query("SELECT COUNT(*) c FROM tasks WHERE project_id = ?").get(projectId) as any).c).toBe(1);
});

test("leaves an already-tracked PR alone", () => {
  const { db, projectId } = freshDb();
  const owned = newId("tsk");
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, pr_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(owned, projectId, "Real hive work", "b", "in_review", "ship", "director", PR.url, now(), now());

  expect(adoptUntrackedPr(db, projectId, PR).outcome).toBe("tracked");
  expect((db.query("SELECT COUNT(*) c FROM tasks WHERE project_id = ?").get(projectId) as any).c).toBe(1);
  // The hive-owned task is untouched.
  expect(getTask(db, owned)!.state).toBe("in_review");
});

test("skips PRs that carry a hive marker, are draft, or are labelled off-limits", () => {
  const { db, projectId } = freshDb();
  expect(adoptUntrackedPr(db, projectId, { ...PR, number: 1, body: "hive-task: abc123def456" }).outcome).toBe("marked");
  expect(adoptUntrackedPr(db, projectId, { ...PR, number: 2, title: "[hive-1625] Adopt PRs" }).outcome).toBe("marked");
  expect(adoptUntrackedPr(db, projectId, { ...PR, number: 3, isDraft: true }).outcome).toBe("draft");
  expect(adoptUntrackedPr(db, projectId, { ...PR, number: 4, labels: [{ name: "No-Hive" }] }, DEFAULT_ADOPT_SKIP_LABELS).outcome).toBe("labelled");
  expect((db.query("SELECT COUNT(*) c FROM tasks WHERE project_id = ?").get(projectId) as any).c).toBe(0);
});

test("retires an adopted task once its PR stops being open", () => {
  const { db, projectId } = freshDb();
  const { task_id } = adoptUntrackedPr(db, projectId, PR);
  expect(retireAdoptedTasks(db, projectId, new Set([999]), true)).toEqual([]);
  // A partial list is never authoritative: nothing is retired from it.
  expect(retireAdoptedTasks(db, projectId, new Set([1]), false)).toEqual([]);
  expect(getTask(db, task_id!)!.state).toBe("queued");
  expect(retireAdoptedTasks(db, projectId, new Set([1]), true)).toEqual([task_id!]);
  expect(getTask(db, task_id!)!.state).toBe("cancelled");
  // Idempotent: a cancelled adoption is never resurrected or re-cancelled.
  expect(retireAdoptedTasks(db, projectId, new Set([1]), true)).toEqual([]);
  expect(adoptUntrackedPr(db, projectId, PR).outcome).toBe("tracked");
});

test("a sweep adopts the untracked PR and leaves the tracked one alone", async () => {
  const { db, projectId } = freshDb({ pr_gardener: { enabled: true, adopt_untracked: true } });
  const owned = newId("tsk");
  const ownedUrl = "https://github.com/acme/monorepo/pull/500";
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, source, pr_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(owned, projectId, "Hive work", "b", "in_review", "ship", "director", ownedUrl, now(), now());

  const listed = [
    { number: 500, url: ownedUrl, title: "[hive-12] Hive work", body: "hive-task: " + owned, isDraft: false, labels: [] },
    { number: 999, url: PR.url, title: PR.title, body: "manual cleanup", isDraft: false, labels: [] },
  ];
  const exec: Exec = async (argv) => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return OK(JSON.stringify(listed));
    if (argv[0] === "git" && argv[1] === "fetch") return { code: 1, stdout: "", stderr: "no remote" };
    return OK();
  };
  const deps = { exec, land: async () => ({ ok: true }), decide: () => ({ id: newId("dec") }) };

  await runPrGardener(db, deps as any);
  const adopted = db.query("SELECT * FROM tasks WHERE source_ref LIKE 'pr-adopt:%'").all() as any[];
  expect(adopted.length).toBe(1);
  expect(adopted[0].pr_url).toBe(PR.url);
  expect(getTask(db, owned)!.state).toBe("in_review");

  // Second sweep past the cadence gate: still exactly one adoption record.
  db.query("DELETE FROM settings WHERE key LIKE 'pr_gardener_last:%'").run();
  await runPrGardener(db, deps as any);
  expect((db.query("SELECT COUNT(*) c FROM tasks WHERE source_ref LIKE 'pr-adopt:%'").get() as any).c).toBe(1);
});

test("a truncated PR list retires nothing", async () => {
  const { db, projectId } = freshDb({ pr_gardener: { enabled: true, adopt_untracked: true } });
  const { task_id } = adoptUntrackedPr(db, projectId, PR); // PR 999, still open on GitHub

  // gh answers with a full page that does not contain PR 999: it sits beyond
  // the page, so it is missing from the list even though it is still open.
  const page = Array.from({ length: ADOPT_LIST_LIMIT }, (_, i) => ({
    number: i + 2000, url: `https://github.com/acme/monorepo/pull/${i + 2000}`,
    title: `PR ${i + 2000}`, body: "", isDraft: false, labels: [{ name: "no-hive" }],
  }));
  const exec: Exec = async (argv) => {
    if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return OK(JSON.stringify(page));
    if (argv[0] === "git" && argv[1] === "fetch") return { code: 1, stdout: "", stderr: "no remote" };
    return OK();
  };
  await runPrGardener(db, { exec, land: async () => ({ ok: true }), decide: () => ({ id: newId("dec") }) } as any);

  expect(getTask(db, task_id!)!.state).toBe("queued");
});
