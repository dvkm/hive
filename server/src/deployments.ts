// Production releases for a project: what is live, what is on the branch, and
// the two buttons that change it.
//
// The model is a consuming project's one-branch deploy (docs/branch-structure-proposal.md
// in that repo): merging into the default branch deploys staging, and
// production is a workflow the director runs by hand. That workflow stamps an
// immutable tag `prod-YYYY-MM-DD-<short sha>`, so the newest such tag IS what is
// live. There is no branch to read and nothing to force-push.
//
// Everything here is a read of that tag list plus `gh workflow run`. Hive holds
// the GitHub credential (the `gh` CLI on the director's Mac) and shells out
// server-side; the browser never sees a token. The two write endpoints sit
// behind the API-token gate in api.ts, which is hive's super-admin equivalent.
//
// Opt-in per project via config.deployments. No config key, no tab.
import type { Exec } from "./exec.ts";
import { safeBranch } from "./exec.ts";
import type { Fetcher } from "./monitors.ts";
import { defaultFetcher, runCheck } from "./monitors.ts";

export interface DeploymentsConfig {
  deploy_workflow?: string; // default prod-deploy.yml
  rollback_workflow?: string; // default prod-rollback.yml
  tag_prefix?: string; // default "prod-"
  workflow_ref?: string; // branch the workflow file is read from; default = the project's default branch
  health_url?: string; // optional live-edge probe
  health_substring?: string;
  posthog_project?: string; // with a POSTHOG_API_KEY secret, enables live flag states
  posthog_host?: string; // default https://us.posthog.com
  flags?: string[]; // flag keys this release gates, in the order to show them
  history?: number; // releases to list; default 15
}

export interface Release {
  tag: string;
  sha: string;
  short: string;
  subject: string;
  created_at: string;
  current: boolean;
}

export interface FlagState {
  key: string;
  name: string | null;
  active: boolean | null; // null = PostHog knows no such flag
  rollout: number | null;
}

export interface DeploymentsStatus {
  branch: string;
  head: { sha: string; short: string; subject: string } | null;
  current: Release | null;
  releases: Release[];
  ahead: number | null; // commits on the branch that production does not have
  health: { ok: boolean; detail: string; url: string } | null;
  flags: { available: boolean; reason: string | null; items: FlagState[] };
  runs: WorkflowRun[];
  errors: string[]; // non-fatal: one section failed, the rest still render
}

export interface WorkflowRun {
  id: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  url: string;
  created_at: string;
  head_sha: string;
}

const DEFAULTS = {
  deploy_workflow: "prod-deploy.yml",
  rollback_workflow: "prod-rollback.yml",
  tag_prefix: "prod-",
  posthog_host: "https://us.posthog.com",
  history: 15,
};

// Config values land as git/gh arguments, so a name that could be read as an
// option (or as a path) falls back to the default rather than being passed on.
// Nothing here is shell-interpreted, but `--ref -x` still misparses.
const safeName = (v: string | undefined, fallback: string): string =>
  v && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) ? v : fallback;

export function deployConfig(config: DeploymentsConfig | undefined, defaultBranch: string) {
  const c = config ?? {};
  return {
    deployWorkflow: safeName(c.deploy_workflow, DEFAULTS.deploy_workflow),
    rollbackWorkflow: safeName(c.rollback_workflow, DEFAULTS.rollback_workflow),
    tagPrefix: safeName(c.tag_prefix, DEFAULTS.tag_prefix),
    ref: safeBranch(c.workflow_ref, defaultBranch),
    healthUrl: c.health_url || null,
    healthSubstring: c.health_substring || undefined,
    posthogProject: c.posthog_project || null,
    posthogHost: (c.posthog_host || DEFAULTS.posthog_host).replace(/\/+$/, ""),
    flags: c.flags ?? [],
    history: c.history ?? DEFAULTS.history,
  };
}

// A rollback target must be a release tag. This is the whole safety of the
// mechanism — a tag that was never live must never reach the workflow — so it
// is checked here as well as inside prod-rollback.yml. Anything that could be
// read as a path or an option is rejected outright.
export function isReleaseTag(tag: string, prefix: string): boolean {
  return tag.startsWith(prefix) && /^[A-Za-z0-9._\-/]+$/.test(tag) && !tag.startsWith("-") && !tag.includes("..");
}

export function isCommitSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(sha);
}

// `git for-each-ref` with a tab-separated format: one call gives every release
// tag with its commit, creation date and subject, already newest-first. Reading
// the local repo (after a tag fetch) rather than the GitHub API keeps this to a
// single subprocess instead of one HTTP call per release.
//
// prod-deploy.yml stamps an ANNOTATED tag, so `%(objectname)` is the tag object,
// not the commit, and `%(contents:subject)` is the deploy note rather than what
// shipped. The `*`-prefixed fields are the dereferenced commit's, and they are
// empty for a lightweight tag — so both are read and the commit's wins. Getting
// this wrong would feed a tag SHA to `rev-list`, and the "commits ahead" count
// would be silently wrong.
const REF_FORMAT = [
  "%(refname:short)",
  "%(objectname)",
  "%(*objectname)",
  "%(creatordate:iso-strict)",
  "%(*contents:subject)",
  "%(contents:subject)",
].join("\t");

async function readReleases(exec: Exec, repoPath: string, prefix: string, limit: number): Promise<Release[]> {
  const r = await exec([
    "git", "-C", repoPath, "for-each-ref",
    "--sort=-creatordate",
    `--count=${limit}`,
    `--format=${REF_FORMAT}`,
    `refs/tags/${prefix}*`,
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tag, tagObject, commitObject, created_at, commitSubject, tagSubject] = line.split("\t");
      const sha = commitObject || tagObject || "";
      return {
        tag,
        sha,
        short: sha.slice(0, 7),
        subject: commitSubject || tagSubject || "",
        created_at,
        current: false,
      };
    })
    .filter((rel) => rel.tag && rel.sha);
}

async function readHead(exec: Exec, repoPath: string, branch: string) {
  const r = await exec(["git", "-C", repoPath, "log", "-1", "--format=%H%x09%s", `origin/${branch}`]);
  if (r.code !== 0) return null;
  const [sha, ...rest] = r.stdout.trim().split("\t");
  if (!sha) return null;
  return { sha, short: sha.slice(0, 7), subject: rest.join("\t") };
}

// How many commits the branch has that production does not. `--count` on a
// range, so a rewritten history cannot make this negative or throw.
async function readAhead(exec: Exec, repoPath: string, from: string, to: string): Promise<number | null> {
  const r = await exec(["git", "-C", repoPath, "rev-list", "--count", `${from}..${to}`]);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(n) ? n : null;
}

async function readRuns(exec: Exec, repoPath: string, workflows: string[]): Promise<WorkflowRun[]> {
  const runs = await Promise.all(
    workflows.map(async (wf) => {
      const r = await exec([
        "gh", "run", "list", "--workflow", wf, "--limit", "5",
        "--json", "databaseId,name,event,status,conclusion,url,createdAt,headSha",
      ], { cwd: repoPath });
      if (r.code !== 0) return [];
      try {
        return (JSON.parse(r.stdout) as any[]).map((x) => ({
          id: x.databaseId,
          name: x.name,
          event: x.event,
          status: x.status,
          conclusion: x.conclusion ?? null,
          url: x.url,
          created_at: x.createdAt,
          head_sha: x.headSha,
        }));
      } catch {
        return [];
      }
    })
  );
  return runs.flat().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// Live flag states from PostHog. Only the keys the project listed are returned,
// in the order it listed them, so the panel says what gates THIS release rather
// than dumping every flag in the account.
// Uses global fetch rather than the injected Fetcher: this call needs an
// Authorization header, which that two-argument shape cannot carry. Tests cover
// the no-credential path, which is the one that runs until a key is stored.
async function readFlags(
  keys: string[],
  projectId: string | null,
  host: string,
  apiKey: string | undefined
): Promise<DeploymentsStatus["flags"]> {
  if (!keys.length) return { available: false, reason: null, items: [] };
  if (!projectId || !apiKey)
    return {
      available: false,
      reason: "No PostHog credential. Add a POSTHOG_API_KEY secret to this project and set deployments.posthog_project.",
      items: keys.map((key) => ({ key, name: null, active: null, rollout: null })),
    };
  try {
    const res = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/feature_flags/?limit=300`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`PostHog returned ${res.status}`);
    const body = (await res.json()) as { results?: any[] };
    const byKey = new Map((body.results ?? []).map((f) => [f.key, f]));
    return {
      available: true,
      reason: null,
      items: keys.map((key) => {
        const f = byKey.get(key);
        if (!f) return { key, name: null, active: null, rollout: null };
        const groups = f.filters?.groups ?? [];
        const rollout = groups.length === 1 ? groups[0]?.rollout_percentage ?? 100 : null;
        return { key, name: f.name || null, active: !!f.active, rollout };
      }),
    };
  } catch (e: any) {
    return {
      available: false,
      reason: `Could not read PostHog: ${String(e?.message ?? e)}`,
      items: keys.map((key) => ({ key, name: null, active: null, rollout: null })),
    };
  }
}

export interface StatusDeps {
  exec: Exec;
  fetcher?: Fetcher;
  posthogKey?: string;
}

export async function deploymentsStatus(
  repoPath: string,
  defaultBranch: string,
  config: DeploymentsConfig | undefined,
  deps: StatusDeps
): Promise<DeploymentsStatus> {
  const c = deployConfig(config, defaultBranch);
  const { exec, fetcher = defaultFetcher } = deps;
  const errors: string[] = [];

  // Release tags and the branch head both come from origin, so refresh both
  // before reading. Fetching only adds refs — it never touches the worktree or
  // HEAD, so it is safe while an agent is working in that repo.
  const fetched = await exec(["git", "-C", repoPath, "fetch", "origin", defaultBranch, "--tags", "--quiet"]);
  if (fetched.code !== 0) errors.push(`git fetch failed: ${fetched.stderr.trim() || `exit ${fetched.code}`}`);

  const [releases, head, runs, flags] = await Promise.all([
    readReleases(exec, repoPath, c.tagPrefix, c.history),
    readHead(exec, repoPath, defaultBranch),
    readRuns(exec, repoPath, [c.deployWorkflow, c.rollbackWorkflow]),
    readFlags(c.flags, c.posthogProject, c.posthogHost, deps.posthogKey),
  ]);

  const current = releases[0] ? { ...releases[0], current: true } : null;
  if (current) releases[0] = current;

  const ahead = current && head ? await readAhead(exec, repoPath, current.sha, head.sha) : null;

  let health: DeploymentsStatus["health"] = null;
  if (c.healthUrl) {
    const r = await runCheck(
      { name: "production", url: c.healthUrl, expect_substring: c.healthSubstring },
      fetcher
    );
    health = { ok: r.ok, detail: r.detail, url: c.healthUrl };
  }

  return { branch: defaultBranch, head, current, releases, ahead, health, flags, runs, errors };
}

// ---------------------------------------------------------------- the buttons
// Both dispatch a workflow_dispatch run through `gh`, which reads the token from
// the CLI's own keyring. Inputs are validated here rather than trusted from the
// browser: the workflows check the same things, but a bad value should fail as
// a 400 in the UI, not as a red run five minutes later.

export type DispatchResult = { ok: true; workflow: string; ref: string } | { ok: false; error: string; status: number };

export async function startDeploy(
  exec: Exec,
  repoPath: string,
  defaultBranch: string,
  config: DeploymentsConfig | undefined,
  commit: string | undefined
): Promise<DispatchResult> {
  const c = deployConfig(config, defaultBranch);
  const sha = (commit ?? "").trim();
  if (sha && !isCommitSha(sha)) return { ok: false, error: `"${sha}" is not a commit SHA.`, status: 400 };
  // Blank commit is the workflow's own "current head of the branch" default.
  const r = await exec(
    ["gh", "workflow", "run", c.deployWorkflow, "--ref", c.ref, "-f", `commit=${sha}`],
    { cwd: repoPath }
  );
  if (r.code !== 0)
    return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `gh workflow run exited ${r.code}`, status: 502 };
  return { ok: true, workflow: c.deployWorkflow, ref: c.ref };
}

export async function startRollback(
  exec: Exec,
  repoPath: string,
  defaultBranch: string,
  config: DeploymentsConfig | undefined,
  tag: string | undefined
): Promise<DispatchResult> {
  const c = deployConfig(config, defaultBranch);
  const want = (tag ?? "").trim();
  // Blank = the workflow's own "the release before the current one" default.
  if (want && !isReleaseTag(want, c.tagPrefix))
    return { ok: false, error: `"${want}" is not a ${c.tagPrefix}* release tag.`, status: 400 };
  const r = await exec(
    ["gh", "workflow", "run", c.rollbackWorkflow, "--ref", c.ref, "-f", `tag=${want}`],
    { cwd: repoPath }
  );
  if (r.code !== 0)
    return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `gh workflow run exited ${r.code}`, status: 502 };
  return { ok: true, workflow: c.rollbackWorkflow, ref: c.ref };
}
