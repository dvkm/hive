// The CLI's priority flags, end to end (HIVE-430): `hive task create
// --priority` and `hive task update --priority` really move the stored value.
// Runs the actual CLI as a subprocess against a real API server, so a broken
// flag name or a dropped field in the request body fails here.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-priority-cli-"));

const { openDb, newId, now } = await import("../src/db.ts");
const { makeHandler } = await import("../src/api.ts");

const CLI = join(import.meta.dir, "..", "..", "cli", "hive.ts");

async function hive(url: string, ...argv: string[]) {
  // HIVE_TASK_ID makes the CLI attribute new tasks to the spawning task; the
  // suite may itself run under an agent, whose task id this DB has never seen.
  const { HIVE_TASK_ID, ...env } = process.env;
  const p = Bun.spawn(["bun", CLI, ...argv], {
    env: { ...env, HIVE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err, code };
}

test("hive task create --priority round-trips, and task update changes it", async () => {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)")
    .run(projectId, "p", "/repo", "{}", now());
  const server = Bun.serve({ port: 0, fetch: makeHandler(db) });
  const url = `http://127.0.0.1:${server.port}`;
  const priorityOf = (id: string) =>
    (db.query("SELECT priority FROM tasks WHERE id = ?").get(id) as any).priority;

  try {
    const created = await hive(url, "task", "create", "--project", projectId, "--title", "urgent thing", "--priority", "now");
    expect(created.code).toBe(0);
    const id = /created task (\S+)/.exec(created.out)?.[1]!;
    expect(id).toBeTruthy();
    expect(priorityOf(id)).toBe("now");

    const updated = await hive(url, "task", "update", id, "--priority", "later");
    expect(updated.code).toBe(0);
    expect(updated.out).toContain("priority: later");
    expect(priorityOf(id)).toBe("later");

    // No --priority on create means the schema default, not an empty column.
    const plain = await hive(url, "task", "create", "--project", projectId, "--title", "ordinary thing");
    const plainId = /created task (\S+)/.exec(plain.out)?.[1]!;
    expect(priorityOf(plainId)).toBe("normal");

    // A typo must fail loudly rather than silently storing junk.
    const bad = await hive(url, "task", "update", id, "--priority", "urgent");
    expect(bad.code).not.toBe(0);
    expect(bad.err + bad.out).toContain("invalid priority");
    expect(priorityOf(id)).toBe("later");
  } finally {
    server.stop(true);
  }
}, 30_000);
