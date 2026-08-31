import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// spawnAgent writes hook settings into the worktree; give it a real scratch dir.
process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-race-"));
const WT = mkdtempSync(join(tmpdir(), "hive-race-wt-"));

import { openDb, newId, now, type DB } from "../src/db.ts";
import { spawnAgent } from "../src/api.ts";
import { Herdr } from "../src/runtime/herdr.ts";
import {
  startRace,
  raceTasks,
  raceView,
  raceIsSettled,
  raceSweep,
  pickWinner,
  optionKey,
  resolveRaceForDecision,
} from "../src/race.ts";
import { getTask, transition, writeEvent } from "../src/state.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
// One numstat line per file: additions, deletions, path.
const numstat: Exec = async (argv) =>
  argv.includes("--numstat") ? OK("4\t1\tsrc/a.ts\n2\t0\tsrc/b.ts\n") : OK();

function freshDb(config: any = { default_branch: "main" }): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(config), now()
  );
  return { db, projectId };
}

function makeTask(db: DB, projectId: string, extra: Record<string, any> = {}): string {
  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, agent_target, depends_on,
      verification_cmds, priority, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, projectId, extra.title ?? "ambiguous thing", extra.brief ?? "do the thing",
    extra.state ?? "queued", extra.kind ?? "ship", extra.source ?? null, extra.agent_target ?? null,
    extra.depends_on ? JSON.stringify(extra.depends_on) : null,
    extra.verification_cmds ? JSON.stringify(extra.verification_cmds) : null,
    extra.priority ?? "normal", t, t
  );
  return id;
}

test("startRace clones the task into N attempts sharing a race_id, split across backends", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { verification_cmds: [{ name: "tests", cmd: "bun test" }], priority: "next" });
  const r = startRace(db, id);
  expect(r.ok).toBe(true);
  if (!r.ok) return;

  const attempts = raceTasks(db, r.race_id);
  expect(attempts.length).toBe(2);
  expect(attempts[0].id).toBe(id); // the flagged task IS attempt 1
  expect(attempts.map((a) => a.agent_override)).toEqual(["claude", "codex"]);
  // The clone carries the same work: brief, kind, contract and priority.
  expect(attempts[1].brief).toBe("do the thing");
  expect(attempts[1].verification_cmds).toEqual([{ name: "tests", cmd: "bun test" }]);
  expect(attempts[1].priority).toBe("next");
  expect(attempts[1].source).toBe("race");
  expect(attempts[1].state).toBe("queued");
  expect(attempts[1].title).toContain("attempt 2");
});

test("startRace refuses tasks that already started, and refuses to race twice", () => {
  const { db, projectId } = freshDb();
  const running = makeTask(db, projectId, { state: "in_progress", agent_target: "tab:1" });
  const r1 = startRace(db, running);
  expect(r1.ok).toBe(false);
  if (!r1.ok) expect(r1.status).toBe(409);

  const id = makeTask(db, projectId);
  expect(startRace(db, id).ok).toBe(true);
  const again = startRace(db, id);
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.error).toContain("already part of a race");
});

test("startRace validates the attempt count and the agent names", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const tooMany = startRace(db, id, { attempts: 4 });
  expect(tooMany.ok).toBe(false);
  const bogus = startRace(db, makeTask(db, projectId), { attempts: 2, agents: ["claude", "gpt5"] });
  expect(bogus.ok).toBe(false);
  if (!bogus.ok) expect(bogus.error).toContain("unknown agent");
});

test("raceView reports diff size, verification and cost per attempt", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { verification_cmds: [{ name: "tests", cmd: "bun test" }] });
  const r = startRace(db, id);
  if (!r.ok) throw new Error(r.error);
  const [a, b] = raceTasks(db, r.race_id);
  db.query("UPDATE tasks SET branch = ? WHERE id = ?").run("hive/a", a.id);
  // Only attempt 1 ran its verification command and attached the output.
  writeEvent(db, { task_id: a.id, source: "agent", type: "evidence", payload: { verify_name: "tests", evidence_id: "ev1" } });
  db.query("INSERT INTO usage (id, task_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(newId(), a.id, now(), "opus", 100, 50, 0, 0, 1.25);

  const view = await raceView(db, r.race_id, numstat);
  expect(view).not.toBeNull();
  expect(view!.attempts[0].diff).toEqual({ files: 2, additions: 6, deletions: 1 });
  expect(view!.attempts[0].verification).toEqual([{ name: "tests", satisfied: true }]);
  expect(view!.attempts[0].cost_usd).toBe(1.25);
  // No branch yet: nothing to diff, and the contract is still unmet.
  expect(view!.attempts[1].diff).toBeNull();
  expect(view!.attempts[1].verification).toEqual([{ name: "tests", satisfied: false }]);
  expect(view!.attempts[1].task_id).toBe(b.id);
});

test("a race settles when every attempt is in, or when its deadline passes", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const r = startRace(db, id, { attempts: 2, deadline_min: 30 });
  if (!r.ok) throw new Error(r.error);
  const [a, b] = raceTasks(db, r.race_id);
  expect(raceIsSettled(db, r.race_id)).toBe(false);

  db.query("UPDATE tasks SET state = 'in_review' WHERE id = ?").run(a.id);
  expect(raceIsSettled(db, r.race_id)).toBe(false); // b is still running
  // The deadline is the release valve for an attempt that never finishes.
  expect(raceIsSettled(db, r.race_id, Date.now() + 31 * 60_000)).toBe(true);

  db.query("UPDATE tasks SET state = 'failed' WHERE id = ?").run(b.id);
  expect(raceIsSettled(db, r.race_id)).toBe(true); // a failed attempt is still a result
});

test("the sweep opens one compare card, and answering it keeps the winner and cancels the rest", async () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId, { verification_cmds: [{ name: "tests", cmd: "bun test" }] });
  const r = startRace(db, id);
  if (!r.ok) throw new Error(r.error);
  const [a, b] = raceTasks(db, r.race_id);
  for (const t of [a, b]) db.query("UPDATE tasks SET state = 'in_review', branch = ? WHERE id = ?").run(`hive/${t.id}`, t.id);
  // Only attempt 2 satisfied the contract, so it is the recommended option.
  writeEvent(db, { task_id: b.id, source: "agent", type: "evidence", payload: { verify_name: "tests", evidence_id: "ev1" } });

  expect(await raceSweep(db, { exec: numstat })).toBe(1);
  expect(await raceSweep(db, { exec: numstat })).toBe(0); // never a second card

  const decision: any = db.query("SELECT * FROM decisions ORDER BY ts DESC LIMIT 1").get();
  const options = JSON.parse(decision.options);
  expect(options.map((o: any) => o.key)).toEqual([optionKey(a.id), optionKey(b.id)]);
  expect(options.find((o: any) => o.recommended).key).toBe(optionKey(b.id));
  expect(decision.decision_class).toBe("race"); // director-only card

  expect(resolveRaceForDecision(db, decision.id, optionKey(b.id))).toBe(true);
  expect(getTask(db, b.id).state).toBe("in_review"); // winner carries on through review
  expect(getTask(db, a.id).state).toBe("cancelled");
  const lost: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'race_lost'").get(a.id);
  expect(JSON.parse(lost.payload).winner_task_id).toBe(b.id);
});

test("pickWinner records what each attempt cost and refuses a second winner", () => {
  const { db, projectId } = freshDb();
  const id = makeTask(db, projectId);
  const r = startRace(db, id);
  if (!r.ok) throw new Error(r.error);
  const [a, b] = raceTasks(db, r.race_id);
  db.query("INSERT INTO usage (id, task_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(newId(), b.id, now(), "opus", 10, 10, 0, 0, 2);

  const picked = pickWinner(db, r.race_id, a.id);
  expect(picked.ok).toBe(true);
  if (!picked.ok) return;
  expect(picked.losers).toEqual([b.id]);
  const won: any = db.query("SELECT payload FROM events WHERE task_id = ? AND type = 'race_won'").get(a.id);
  expect(JSON.parse(won.payload).race_cost_usd).toBe(2); // the whole race, winner included

  const again = pickWinner(db, r.race_id, b.id);
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.status).toBe(409);
});

test("resolveRaceForDecision ignores cards that are not race comparisons", () => {
  const { db, projectId } = freshDb();
  makeTask(db, projectId);
  expect(resolveRaceForDecision(db, "dec_nope", "approve")).toBe(false);
});

// A herdr stub for the full spawn (worktree + fleet workspace + tab + agent
// start) that records the argv every `agent start` was given.
function stubHerdr(): { herdr: Herdr; starts: string[][] } {
  const starts: string[][] = [];
  const has = (argv: string[], ...xs: string[]) => xs.every((x) => argv.includes(x));
  const exec: Exec = async (argv) => {
    if (has(argv, "worktree", "create"))
      return OK(`{"result":{"worktree":{"path":${JSON.stringify(WT)},"branch":"hive/x","open_workspace_id":"w1"}}}`);
    if (has(argv, "workspace", "list")) return OK('{"result":{"workspaces":[{"workspace_id":"wF","label":"hive-fleet"}]}}');
    if (has(argv, "tab", "create")) return OK('{"result":{"tab":{"tab_id":"wF:t2"}}}');
    if (has(argv, "agent", "start")) starts.push(argv);
    return OK();
  };
  return { herdr: new Herdr(exec, "herdr"), starts };
}

test("each attempt spawns on its own backend, whatever the project's agent is", async () => {
  const { db, projectId } = freshDb({ default_branch: "main", agent: "claude" });
  const id = makeTask(db, projectId);
  const r = startRace(db, id);
  if (!r.ok) throw new Error(r.error);
  const [a, b] = raceTasks(db, r.race_id);

  const { herdr, starts } = stubHerdr();
  expect((await spawnAgent(db, herdr, a.id)).ok).toBe(true);
  expect((await spawnAgent(db, herdr, b.id)).ok).toBe(true);
  // Attempt 1 runs the project default (claude, no codex argv); attempt 2 is
  // pinned to codex, which is the whole point of racing across backends.
  expect(starts[0].some((x) => x === "codex")).toBe(false);
  expect(starts[1].some((x) => x === "codex")).toBe(true);
});
