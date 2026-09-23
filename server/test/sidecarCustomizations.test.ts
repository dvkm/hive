// HIVE-639: hive's own one-shot `claude -p` calls run with cwd inside a
// worktree, so the CLI used to load that repo's CLAUDE.md, the host user's
// global CLAUDE.md, every MCP server and every hook into the cached prefix of
// every turn. Measured on 2026-09-11 in a project worktree whose AGENTS.md was
// 201KB: 92,128 prefix tokens per call, 18,057 with `--safe-mode`.
//
// The advisory sidecars now pass NO_CUSTOMIZATIONS. The reviewer deliberately
// does NOT: its verdicts gate merges, and the repo's own conventions are input
// to that judgement. Both directions are pinned here, because the cheap mistake
// in either direction is silent — a dropped flag just costs money, and an added
// one just changes review verdicts.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hive-sidecar-flags-"));
process.env.HIVE_HOME = HOME;

const { openDb, newId, now } = await import("../src/db.ts");
const { NO_CUSTOMIZATIONS } = await import("../src/planner.ts");
const { driftCheckOnce } = await import("../src/drift.ts");
const { verifyRisks } = await import("../src/reviewer.ts");
const { transition } = await import("../src/state.ts");
import type { DB } from "../src/db.ts";
import type { Exec } from "../src/exec.ts";

function setup(): { db: DB; id: string } {
  const db = openDb(":memory:");
  const pid = newId("proj");
  const t = now();
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    pid, "p", "/repo", "{}", t
  );
  const id = newId();
  db.query(
    "INSERT INTO tasks (id, project_id, title, brief, state, kind, branch, created_at, updated_at) VALUES (?,?,?,?, 'queued','ship',?,?,?)"
  ).run(id, pid, "consolidate the exclusion", "Touch only server/src/supervision.ts.", "hive/abc", t, t);
  transition(db, id, "in_progress");
  return { db, id };
}

// A `git` reporting three commits over files well outside the brief: the drift
// watch only spends a model call once the branch is at least DEFAULT_COMMIT_STEP
// commits deep.
const git: Exec = async (argv) => {
  if (argv.includes("--name-only"))
    return { code: 0, stdout: ["server/src/health.ts", "web/src/lib/needsYou.ts", "web/test/needsYou.test.ts"].join("\n"), stderr: "" };
  if (argv.includes("--format=%s"))
    return { code: 0, stdout: "rewrite the needs-you panel\nrestyle the health strip\nadd a panel test", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

test("the drift sidecar drops machine customizations; the risk judge keeps them", async () => {
  const { db, id } = setup();

  const driftArgvs: string[][] = [];
  const driftJudge = async (argv: string[]) => {
    driftArgvs.push(argv);
    return { code: 0, stdout: JSON.stringify({ result: JSON.stringify({ drifted: false, why: "within scope" }) }), stderr: "", timedOut: false };
  };
  await driftCheckOnce(db, { exec: driftJudge, shellExec: git });

  expect(driftArgvs.length).toBeGreaterThan(0);
  expect(driftArgvs[0]).toContain(NO_CUSTOMIZATIONS);
  // The flag must sit before the prompt, not replace anything the call needs.
  expect(driftArgvs[0]).toContain("--output-format");
  expect(driftArgvs[0]!.indexOf(NO_CUSTOMIZATIONS)).toBeLessThan(driftArgvs[0]!.indexOf("--output-format"));

  const riskArgvs: string[][] = [];
  const riskJudge = async (argv: string[]) => {
    riskArgvs.push(argv);
    return { code: 0, stdout: JSON.stringify({ result: '{"verdict":"refuted","why":"guarded upstream"}' }), stderr: "", timedOut: false };
  };
  const task: any = db.query("SELECT * FROM tasks WHERE id = ?").get(id);
  await verifyRisks(db, task, { risks: ["the guard runs after the write"], head: "head-a", diff: "d" }, { exec: riskJudge, shellExec: git });

  expect(riskArgvs.length).toBeGreaterThan(0);
  expect(riskArgvs[0]).not.toContain(NO_CUSTOMIZATIONS);
});
