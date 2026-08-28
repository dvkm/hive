import { test, expect } from "bun:test";
import { openDb, newId, now, setSetting, type DB } from "../src/db.ts";
import { followServingBranch, resolveServingFollowForDecision } from "../src/servingBranch.ts";
import { apiAnswerDecision } from "../src/api.ts";
import type { Herdr } from "../src/runtime/herdr.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const stubHerdr = { send: async () => ({ ok: true }) } as unknown as Herdr;

const SERVING = "/repo-live";
const REPO = "/repo";

function freshDb(): { db: DB; projectId: string; taskId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", REPO, JSON.stringify({ default_branch: "main" }), now()
  );
  const taskId = newId();
  const t = now();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, created_at, updated_at) VALUES (?,?,?,?,'verifying','ship',?,?)"
  ).run(taskId, projectId, "landed thing", "", t, t);
  return { db, projectId, taskId };
}

// A checkout that answers git the way the live pair does: hive-live and hive are
// two worktrees of one repo, hive-live sits on `branch`, and `merge` decides
// whether the follow succeeds or conflicts.
function gitStub(opts: { branch: string; merge?: ExecResult; conflicts?: string[] }) {
  const calls: string[][] = [];
  const exec: Exec = async (argv, o) => {
    calls.push(argv);
    const cmd = argv.slice(1).join(" ");
    // What a real linked worktree answers: the main repo's .git, absolute from
    // the worktree and relative from the main checkout.
    if (cmd === "rev-parse --git-common-dir") return OK(o?.cwd === SERVING ? `${REPO}/.git` : ".git");
    if (cmd === "branch --show-current") return OK(opts.branch);
    if (cmd.startsWith("merge ")) return opts.merge ?? OK("Updating aaaa..bbbb");
    if (cmd === "diff --name-only --diff-filter=U") return OK((opts.conflicts ?? []).join("\n"));
    if (cmd === "merge --abort") return OK();
    if (cmd === "rev-parse HEAD") return OK("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    return OK();
  };
  return { exec, calls, merges: () => calls.filter((c) => c[1] === "merge" && c[2] !== "--abort") };
}

const follow = (db: DB, projectId: string, exec: Exec, taskId?: string) =>
  followServingBranch(db, { exec, cwd: SERVING, repoPath: REPO, projectId, base: "main", taskId });

test("serving checkout on another branch merges main after a land", async () => {
  const { db, projectId, taskId } = freshDb();
  const git = gitStub({ branch: "live" });

  const res = await follow(db, projectId, git.exec, taskId);

  expect(res.status).toBe("followed");
  expect(git.merges()).toEqual([["git", "merge", "main", "--no-edit"]]);
  const deployed: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'deployed'").get(taskId);
  expect(JSON.parse(deployed.payload).head_sha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

test("serving checkout already on main merges nothing", async () => {
  const { db, projectId, taskId } = freshDb();
  const git = gitStub({ branch: "main" });

  const res = await follow(db, projectId, git.exec, taskId);

  expect(res).toEqual({ status: "skipped", reason: "serving checkout is already on main" });
  expect(git.merges()).toEqual([]);
});

test("a detached serving checkout is left alone", async () => {
  const { db, projectId } = freshDb();
  const git = gitStub({ branch: "" });

  expect((await follow(db, projectId, git.exec)).status).toBe("skipped");
  expect(git.merges()).toEqual([]);
});

test("another project's repo never moves the serving checkout", async () => {
  const { db, projectId } = freshDb();
  const calls: string[][] = [];
  const exec: Exec = async (argv, o) => {
    calls.push(argv);
    if (argv.slice(1).join(" ") === "rev-parse --git-common-dir") return OK(o?.cwd === SERVING ? "/a/.git" : "/b/.git");
    return OK("live");
  };

  expect((await follow(db, projectId, exec)).status).toBe("skipped");
  expect(calls.some((c) => c[1] === "merge")).toBe(false);
});

test("a conflict aborts, opens exactly one card, and stops following until it is answered", async () => {
  const { db, projectId, taskId } = freshDb();
  const git = gitStub({
    branch: "live",
    merge: { code: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict in server/src/api.ts" },
    conflicts: ["server/src/api.ts", "server/src/landQueue.ts"],
  });

  const first = await follow(db, projectId, git.exec, taskId);
  expect(first.status).toBe("conflict");
  expect(first.status === "conflict" && first.files).toEqual(["server/src/api.ts", "server/src/landQueue.ts"]);
  expect(git.calls.some((c) => c.join(" ") === "git merge --abort")).toBe(true);
  // Nothing destructive, ever.
  expect(git.calls.some((c) => c.includes("reset") || c.includes("--force") || c.includes("-f"))).toBe(false);

  // The next land must not stack a second card, and must not retry the merge.
  const second = await follow(db, projectId, git.exec, taskId);
  expect(second.status).toBe("skipped");
  expect(git.merges().length).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'").get()).toEqual({ n: 1 });

  // The card names the files, so the director knows what to resolve.
  const card: any = db.query("SELECT * FROM decisions").get();
  expect(card.context).toContain("server/src/api.ts");
  expect(card.title).toContain("live");

  // Answering it resumes following and closes the parked task.
  expect(apiAnswerDecision(db, stubHerdr, card.id, { answer_key: "resolved", source: "director" }).status).toBe(200);
  const clean = gitStub({ branch: "live" });
  expect((await follow(db, projectId, clean.exec, taskId)).status).toBe("followed");
  const holder: any = db.query("SELECT state FROM tasks WHERE source = 'serving-follow'").get();
  expect(holder.state).toBe("cancelled");
});

test("'leave it alone' holds following until the server restarts", async () => {
  const { db, projectId, taskId } = freshDb();
  setSetting(db, "server_started_at", "2026-08-25T00:00:00.000Z");
  const git = gitStub({ branch: "live", merge: { code: 1, stdout: "", stderr: "CONFLICT" }, conflicts: ["a.ts"] });
  await follow(db, projectId, git.exec, taskId);
  const card: any = db.query("SELECT * FROM decisions").get();
  apiAnswerDecision(db, stubHerdr, card.id, { answer_key: "hold", source: "director" });

  const held = gitStub({ branch: "live" });
  expect((await follow(db, projectId, held.exec, taskId)).status).toBe("skipped");
  expect(held.merges()).toEqual([]);

  // A restart stamps a new boot time, which is what lets the hold expire.
  setSetting(db, "server_started_at", "2026-08-25T01:00:00.000Z");
  const after = gitStub({ branch: "live" });
  expect((await follow(db, projectId, after.exec, taskId)).status).toBe("followed");
});

test("an unrelated card is not claimed by the serving-follow resolver", () => {
  const { db } = freshDb();
  expect(resolveServingFollowForDecision(db, "dec_nope", "resolved")).toBe(false);
});
