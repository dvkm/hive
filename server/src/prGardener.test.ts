import { describe, expect, test } from "bun:test";
import { classifyPr, DEFAULT_SENSITIVE_PATHS, GH_FILES_PAGE_CAP, matchesSensitivePath, runPrGardener, type ClassifierInput } from "./prGardener.ts";
import { validateProjectConfig } from "./projectConfig.ts";
import { openDb, newId, now, type DB } from "./db.ts";
import type { Exec, ExecResult } from "./exec.ts";

const ready: ClassifierInput = {
  draft: false,
  mergeState: "CLEAN",
  ci: "passing",
  stale: false,
  superseded: false,
  sensitive: false,
  linkedTaskState: "in_review",
};

describe("PR Gardener classifier", () => {
  test("lands only a green, clean, linked PR", () => {
    expect(classifyPr(ready).action).toBe("land");
    expect(classifyPr({ ...ready, linkedTaskState: null }).action).toBe("decision");
  });

  test("never lands while the director is still deciding", () => {
    expect(classifyPr({ ...ready, directorDeciding: true }).action).toBe("wait");
    expect(classifyPr({ ...ready, directorDeciding: true, mergeState: "DIRTY" }).action).toBe("wait");
    // The director's own explicit choice still wins over the wait.
    expect(classifyPr({ ...ready, directorDeciding: true, override: "force_land" }).action).toBe("land");
    expect(classifyPr({ ...ready, directorDeciding: true, override: "force_close" }).action).toBe("close");
  });

  test("an adopted PR needs a decision, and says why in the director's words", () => {
    const adopted = classifyPr({ ...ready, linkedTaskState: "queued", adopted: true });
    expect(adopted.action).toBe("decision");
    expect(adopted.reason).toContain("opened outside Hive");
  });

  test("sensitive paths always need a decision", () => {
    expect(classifyPr({ ...ready, sensitive: true }).action).toBe("decision");
  });

  test("stale alone is never enough to close", () => {
    expect(classifyPr({ ...ready, ci: "pending", stale: true }).action).toBe("decision");
  });

  test("closes a proven superseded PR only when enabled", () => {
    const superseded = { ...ready, ci: "pending" as const, superseded: true };
    expect(classifyPr(superseded).action).toBe("decision");
    expect(classifyPr({ ...superseded, autoCloseSuperseded: true }).action).toBe("close");
  });

  test("does not dispatch duplicate or unbounded repair work", () => {
    expect(classifyPr({ ...ready, mergeState: "DIRTY", actionInFlight: true }).action).toBe("wait");
    expect(classifyPr({ ...ready, ci: "failing", fixAttempts: 2, maxFixAttempts: 2 }).action).toBe("decision");
  });

  test("does not repeat work while a repair or decision is active", () => {
    expect(classifyPr({ ...ready, override: "force_close", actionInFlight: true }).action).toBe("wait");
    expect(classifyPr({ ...ready, decisionOpen: true }).action).toBe("wait");
  });
});

describe("PR Gardener sensitive path denylist", () => {
  test("matches exact files and nested globs", () => {
    const paths = ["src/auth/tokens.ts", "deploy/prod/service.yaml", "README.md"];
    expect(matchesSensitivePath(paths, ["src/auth/**"])).toBe(true);
    expect(matchesSensitivePath(paths, ["deploy/prod/**"])).toBe(true);
    expect(matchesSensitivePath(paths, ["newsletter/SEND_LIVE"])).toBe(false);
  });

  test("protects workflows, env files, and secrets by default", () => {
    expect(matchesSensitivePath([".github/workflows/ci.yml"], DEFAULT_SENSITIVE_PATHS)).toBe(true);
    expect(matchesSensitivePath([".env", "config/prod.env"], DEFAULT_SENSITIVE_PATHS)).toBe(true);
    expect(matchesSensitivePath(["secrets/token", "config/secrets/token"], DEFAULT_SENSITIVE_PATHS)).toBe(true);
  });
});

function freshDb(config: any): { db: DB; projectId: string } {
  const db = openDb(":memory:");
  const projectId = newId("proj");
  db.query("INSERT INTO projects (id, name, repo_path, config, created_at) VALUES (?,?,?,?,?)").run(
    projectId, "p", "/repo", JSON.stringify(config), now()
  );
  return { db, projectId };
}

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function gardenerDeps(db: DB, exec: Exec) {
  return {
    exec,
    land: async () => ({ ok: true }),
    decide: (input: { task_id: string; title: string; context: string; options: any[] }) => {
      const id = newId("dec");
      db.query(
        "INSERT INTO decisions (id, task_id, ts, title, context, options, status) VALUES (?,?,?,?,?,?,?)"
      ).run(id, input.task_id, now(), input.title, input.context, JSON.stringify(input.options), "open");
      return { id };
    },
  };
}

describe("PR Gardener wiring", () => {
  test("with no sensitive_paths config at all, a workflow-file PR still lands on decision, never auto-land/auto-close", async () => {
    const { db, projectId } = freshDb({ pr_gardener: { enabled: true } });
    const pr = { number: 1, url: "https://github.com/o/r/pull/1", title: "sneaky", isDraft: false, updatedAt: now(), mergeStateStatus: "CLEAN", statusCheckRollup: [{ conclusion: "SUCCESS" }], files: [{ path: ".github/workflows/deploy.yml" }] };
    const exec = ((argv: string[]): Promise<ExecResult> => {
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return Promise.resolve(OK(JSON.stringify([pr])));
      return Promise.resolve(OK());
    }) as Exec;

    await runPrGardener(db, gardenerDeps(db, exec));

    const item: any = db.query("SELECT * FROM pr_gardener_items WHERE project_id = ? AND pr_number = ?").get(projectId, 1);
    expect(item.classification).toBe("decision");
    expect(item.sensitive).toBe(1);
  });

  test("a PR whose file list hits the gh pr list cap is treated as sensitive, with a note naming the truncation", async () => {
    const { db, projectId } = freshDb({ pr_gardener: { enabled: true } });
    const files = Array.from({ length: GH_FILES_PAGE_CAP }, (_, i) => ({ path: `src/file${i}.ts` }));
    const pr = { number: 2, url: "https://github.com/o/r/pull/2", title: "huge", isDraft: false, updatedAt: now(), mergeStateStatus: "CLEAN", statusCheckRollup: [{ conclusion: "SUCCESS" }], files };
    const exec = ((argv: string[]): Promise<ExecResult> => {
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "list") return Promise.resolve(OK(JSON.stringify([pr])));
      return Promise.resolve(OK());
    }) as Exec;

    await runPrGardener(db, gardenerDeps(db, exec));

    const item: any = db.query("SELECT * FROM pr_gardener_items WHERE project_id = ? AND pr_number = ?").get(projectId, 2);
    expect(item.classification).toBe("decision");
    expect(item.sensitive).toBe(1);
    expect(item.reason).toContain("truncated");
  });
});

test("PR Gardener config validates its guarded settings", () => {
  expect(validateProjectConfig({ pr_gardener: { enabled: true, cadence: "30m", sensitive_paths: ["src/auth/**"], max_gardener_agents: 1 } })).toBeNull();
  expect(validateProjectConfig({ pr_gardener: { max_gardener_agents: 0 } })).toContain("positive integer");
  expect(validateProjectConfig({ pr_gardener: { max_actions_per_sweep: 0 } })).toContain("positive integer");
  expect(validateProjectConfig({ pr_gardener: { adopt_untracked: true, adopt_skip_labels: ["no-hive"] } })).toBeNull();
  expect(validateProjectConfig({ pr_gardener: { adopt_untracked: "yes" } })).toContain("adopt_untracked");
  expect(validateProjectConfig({ pr_gardener: { surprise: true } })).toContain("not a known PR gardener key");
});
