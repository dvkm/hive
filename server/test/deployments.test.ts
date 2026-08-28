import { test, expect } from "bun:test";
import {
  deployConfig,
  deploymentsStatus,
  isCommitSha,
  isReleaseTag,
  startDeploy,
  startRollback,
} from "../src/deployments.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const OK = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const FAIL = (stderr = "boom"): ExecResult => ({ code: 1, stdout: "", stderr });

// Two annotated release tags, in the tab-separated shape readReleases parses:
// tag, TAG object sha, dereferenced COMMIT sha, creation date, commit subject,
// tag message subject.
const TAGS = [
  ["prod-2026-08-25-abc1234", "tagobj1", "abc1234def5678", "2026-08-25T10:00:00+09:00", "Fix the byline fallback", "Deployed to production by the director"],
  ["prod-2026-08-24-9999999", "tagobj2", "9999999aaaa1111", "2026-08-24T09:00:00+09:00", "Add the quota column", "Deployed to production by the director"],
]
  .map((row) => row.join("\t"))
  .join("\n");

interface Calls {
  argv: string[][];
}

// Answers only the reads deploymentsStatus makes; everything else is an empty
// success, so an unexpected call shows up as a missing section, not a throw.
function repoStub(calls: Calls, over: Partial<Record<string, ExecResult>> = {}): Exec {
  return async (argv) => {
    calls.argv.push(argv);
    const sub = argv[3]; // git -C <path> <sub>
    if (over[sub!]) return over[sub!]!;
    if (argv[0] === "gh" && argv[1] === "run") return OK("[]");
    if (argv[0] === "gh") return OK();
    if (sub === "fetch") return OK();
    if (sub === "for-each-ref") return OK(TAGS);
    if (sub === "log") return OK("headsha1111111\tLatest merge on main\n");
    if (sub === "rev-list") return OK("7\n");
    return OK();
  };
}

test("defaults fill in for an empty deployments config", () => {
  const c = deployConfig({}, "main");
  expect(c.deployWorkflow).toBe("prod-deploy.yml");
  expect(c.rollbackWorkflow).toBe("prod-rollback.yml");
  expect(c.tagPrefix).toBe("prod-");
  expect(c.ref).toBe("main");
});

test("a workflow name or ref that could be read as an option falls back", () => {
  const c = deployConfig({ deploy_workflow: "--version", workflow_ref: "--upload-pack=evil", tag_prefix: "a b" }, "main");
  expect(c.deployWorkflow).toBe("prod-deploy.yml");
  expect(c.ref).toBe("main");
  expect(c.tagPrefix).toBe("prod-");
});

test("only a prefixed release tag is a rollback target", () => {
  expect(isReleaseTag("prod-2026-08-25-abc1234", "prod-")).toBe(true);
  expect(isReleaseTag("v1.2.3", "prod-")).toBe(false);
  expect(isReleaseTag("prod-../../etc/passwd", "prod-")).toBe(false);
  expect(isReleaseTag("prod-a;rm -rf /", "prod-")).toBe(false);
  expect(isCommitSha("abc1234")).toBe(true);
  expect(isCommitSha("main")).toBe(false);
});

test("status reads the newest tag as what is live, with the COMMIT sha not the tag object", async () => {
  const calls: Calls = { argv: [] };
  const s = await deploymentsStatus("/repo", "main", {}, { exec: repoStub(calls) });

  expect(s.current?.tag).toBe("prod-2026-08-25-abc1234");
  // The dereferenced commit, never "tagobj1" — the ahead count depends on it.
  expect(s.current?.sha).toBe("abc1234def5678");
  expect(s.current?.subject).toBe("Fix the byline fallback");
  expect(s.current?.current).toBe(true);
  expect(s.releases).toHaveLength(2);
  expect(s.releases[1]!.current).toBe(false);
  expect(s.head?.subject).toBe("Latest merge on main");
  expect(s.ahead).toBe(7);
  expect(s.errors).toEqual([]);

  const revList = calls.argv.find((a) => a[3] === "rev-list");
  expect(revList).toContain("abc1234def5678..headsha1111111");
});

test("a failed fetch is reported but the rest of the page still renders", async () => {
  const calls: Calls = { argv: [] };
  const s = await deploymentsStatus("/repo", "main", {}, { exec: repoStub(calls, { fetch: FAIL("no network") }) });
  expect(s.errors[0]).toContain("no network");
  expect(s.current?.tag).toBe("prod-2026-08-25-abc1234");
});

test("no releases yet → nothing live, and no ahead count to invent", async () => {
  const calls: Calls = { argv: [] };
  const s = await deploymentsStatus("/repo", "main", {}, { exec: repoStub(calls, { "for-each-ref": OK("") }) });
  expect(s.current).toBeNull();
  expect(s.releases).toEqual([]);
  expect(s.ahead).toBeNull();
});

test("flags say why they are blank instead of claiming a state", async () => {
  const calls: Calls = { argv: [] };
  const s = await deploymentsStatus("/repo", "main", { flags: ["insights-page-redesign"] }, { exec: repoStub(calls) });
  expect(s.flags.available).toBe(false);
  expect(s.flags.reason).toContain("POSTHOG_API_KEY");
  expect(s.flags.items).toEqual([{ key: "insights-page-redesign", name: null, active: null, rollout: null }]);
});

test("deploy dispatches the workflow with the commit, blank meaning branch head", async () => {
  const calls: Calls = { argv: [] };
  const r = await startDeploy(repoStub(calls), "/repo", "main", {}, "abc1234def5678");
  expect(r.ok).toBe(true);
  const run = calls.argv.find((a) => a[1] === "workflow")!;
  expect(run).toEqual(["gh", "workflow", "run", "prod-deploy.yml", "--ref", "main", "-f", "commit=abc1234def5678"]);

  const blank: Calls = { argv: [] };
  await startDeploy(repoStub(blank), "/repo", "main", {}, undefined);
  expect(blank.argv.find((a) => a[1] === "workflow")).toContain("commit=");
});

test("deploy refuses anything that is not a commit SHA", async () => {
  const calls: Calls = { argv: [] };
  const r = await startDeploy(repoStub(calls), "/repo", "main", {}, "main");
  expect(r).toMatchObject({ ok: false, status: 400 });
  expect(calls.argv.find((a) => a[1] === "workflow")).toBeUndefined();
});

test("rollback refuses a tag that was never a release", async () => {
  const calls: Calls = { argv: [] };
  const r = await startRollback(repoStub(calls), "/repo", "main", {}, "v1.2.3");
  expect(r).toMatchObject({ ok: false, status: 400 });
  expect(calls.argv.find((a) => a[1] === "workflow")).toBeUndefined();

  const good: Calls = { argv: [] };
  const ok = await startRollback(repoStub(good), "/repo", "main", {}, "prod-2026-08-24-9999999");
  expect(ok.ok).toBe(true);
  expect(good.argv.find((a) => a[1] === "workflow")).toEqual([
    "gh", "workflow", "run", "prod-rollback.yml", "--ref", "main", "-f", "tag=prod-2026-08-24-9999999",
  ]);
});

test("a gh failure surfaces its message rather than a silent success", async () => {
  const exec: Exec = async (argv) => (argv[0] === "gh" ? FAIL("HTTP 403: Resource not accessible") : OK());
  const r = await startDeploy(exec, "/repo", "main", {}, undefined);
  expect(r).toMatchObject({ ok: false, status: 502 });
  expect((r as any).error).toContain("403");
});
