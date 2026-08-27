// Render an image proof when a UI task has none.
//
// syncAttachments can only upload screenshots a task already holds. A UI task
// that attached none still reaches its Jira ticket as a wall of text. This
// renders one or two pictures at review time, using the TARGET repo's own
// Playwright harness (hive itself has no browser), and saves them as ordinary
// evidence rows — the existing upload path carries them to Jira from there.
//
// The picture MUST come from the PR branch, so hive never points a browser at
// whatever app happens to be running. It requires the repo's Playwright config
// to declare a `webServer`. A generated wrapper forces
// `reuseExistingServer: false`, so Playwright starts the app from the task's
// worktree instead of borrowing a server someone else started. A repo whose
// harness cannot do that renders nothing and says why.
//
// Running a repo's own Playwright config is code execution: its globalSetup,
// its webServer command, and everything they import. So it is fenced twice.
// First, it is off unless the director marks that project trusted in project
// config (`render_proof: true`). Second, the run happens inside the same
// seatbelt sandbox hive's codex agents get (`--sandbox workspace-write`): it
// may write to its own worktree and the temp dirs, and nothing else on the Mac.
//
// ponytail: hive does not pick ports or wait on readiness itself — the repo's
// own webServer block already owns both. If a repo ever needs hive to boot the
// app for it, that is a bigger machine and a separate task.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DB } from "../db.ts";
import { evidenceDir, newId, now } from "../db.ts";
import { writeEvent } from "../state.ts";
import { broadcast } from "../bus.ts";
import type { Exec } from "../exec.ts";
import { defaultExec } from "../exec.ts";

// Two pictures, never a contact sheet of every viewport: the director's rule is
// a couple of captioned proofs.
const MAX_ROUTES = 2;
// A cold Playwright run compiles the spec and starts a browser. Generous, but
// bounded: this runs inside the Jira sync cycle.
const RENDER_TIMEOUT_MS = 180_000;
const UI_DIRS = ["web", "cms"];

export interface RenderOutcome {
  created: number;
  reason?: string; // why nothing was rendered, for the sync ledger
}

// ---- trust gate ----------------------------------------------------------
// Off for every project until the director opts that repo in, because the run
// executes the PR branch's own config. A project's config is per repo, so the
// flag IS the trusted-repo list.
export function renderProofTrusted(db: DB, projectId: string): boolean {
  const row = db.query("SELECT config FROM projects WHERE id = ?").get(projectId) as { config?: string } | undefined;
  try {
    return JSON.parse(row?.config ?? "{}")?.render_proof === true;
  } catch {
    return false;
  }
}

// ---- sandbox -------------------------------------------------------------
// macOS seatbelt, the same mechanism behind codex's `--sandbox workspace-write`.
// Everything is allowed EXCEPT writing outside the task's worktree and the temp
// and package-cache dirs a browser run needs. No seatbelt binary (any non-macOS
// host) means no render at all: hive will not run repo code unfenced.
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function seatbelt(root: string): { argv: string[] } | { reason: string } {
  if (!existsSync(SANDBOX_EXEC))
    return { reason: "no seatbelt sandbox on this host, and hive will not run repo code unsandboxed" };
  const home = process.env.HOME ?? "";
  const writable = [root, "/private/tmp", "/private/var/folders", `${home}/Library/Caches`, `${home}/.npm`];
  // A path with a quote or backslash would break out of the profile's own
  // string literal. None can, in practice; refusing is still cheaper than trust.
  if (writable.some((p) => /["\\\n]/.test(p))) return { reason: "worktree path is not safe to sandbox" };
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(deny file-write*)",
    `(allow file-write* ${writable.map((p) => `(subpath "${p}")`).join(" ")} (literal "/dev/null"))`,
  ].join("\n");
  return { argv: [SANDBOX_EXEC, "-p", profile] };
}

// Which UI directory of the repo to drive, and where its specs live. Returns a
// reason instead when hive cannot safely render — the quiet degrade to today's
// text-only behaviour.
type Harness = { config: string; dir: string; testDir: string } | { reason: string };

function findHarness(root: string, files: string[]): Harness {
  const touched = UI_DIRS.filter((d) => files.some((f) => f === d || f.startsWith(`${d}/`)));
  for (const rel of [...touched, "."]) {
    const dir = join(root, rel);
    const config = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]
      .map((name) => join(dir, name))
      .find((path) => existsSync(path));
    if (!config) continue;
    let text = "";
    try {
      text = readFileSync(config, "utf8");
    } catch {
      continue;
    }
    // Playwright only runs spec files that live under its configured testDir, so
    // the generated spec has to be written there. Read straight out of the
    // config text: evaluating the config would mean running repo code in the
    // server. Same for the two server questions below.
    const found = text.match(/testDir\s*:\s*['"`]([^'"`]+)['"`]/);
    const testDir = found ? found[1].replace(/^\.\//, "") : null;
    if (!testDir) continue;
    const testPath = resolve(dir, testDir);
    if (!existsSync(testPath)) continue;
    const fromRoot = relative(realpathSync(root), realpathSync(testPath));
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
      return { reason: `${rel}/playwright testDir is outside the task worktree` };
    if (!/\bwebServer\s*:/.test(text))
      return { reason: `${rel}/playwright config has no webServer, so hive cannot serve the PR branch` };
    return { config: basename(config), dir, testDir: relative(dir, testPath) };
  }
  return { reason: "no Playwright config with a testDir in web/ or cms/" };
}

// A route a person can actually open, derived from the changed files. Next-style
// `app/` and `pages/` trees map a directory to a URL, which is the whole trick.
// Three kinds of path are dropped, because each would produce a worse picture
// than none: a `[param]` route (hive has no id to put there, so it renders a
// 404), an `api/` path, and an `app/**/route.ts` handler (both answer with JSON
// or an error, not a page).
export function routesFromFiles(files: string[]): string[] {
  const routes: string[] = [];
  for (const file of files) {
    const m = file.match(/(?:^|\/)(?:app|pages)\/(.*)$/);
    if (!m) continue;
    const parts = m[1].split("/");
    const dirs = parts.slice(0, -1); // drop the filename: page.tsx, route.ts, Foo.tsx
    if (/^route\.[cm]?[jt]sx?$/.test(parts[parts.length - 1] ?? "")) continue;
    if (dirs.includes("api")) continue;
    const segments = dirs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@") && !s.startsWith("_"));
    if (segments.some((s) => s.includes("["))) continue;
    const route = `/${segments.join("/")}`.replace(/\/+$/, "") || "/";
    if (!routes.includes(route)) routes.push(route);
    if (routes.length === MAX_ROUTES) break;
  }
  return routes.length ? routes : ["/"];
}

function specSource(routes: string[], outDir: string): string {
  const shots = routes
    .map(
      (route, i) => `
test(${JSON.stringify(`hive proof ${i + 1}: ${route}`)}, async ({ page }) => {
  await page.goto(${JSON.stringify(route)});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.screenshot({ path: ${JSON.stringify(join(outDir, `proof-${i + 1}.png`))} });
});`
    )
    .join("\n");
  // Chromium's own helper sandbox cannot nest inside the seatbelt: its GPU
  // process dies on launch and takes the run with it. The outer seatbelt is the
  // fence that matters here, so the inner one is turned off.
  const launch = `test.use({ launchOptions: { chromiumSandbox: false, args: ["--disable-gpu"] } });`;
  return `// Generated by hive at review time. Deleted as soon as it has run.\nimport { test } from "@playwright/test";\n${launch}\n${shots}\n`;
}

function configSource(config: string): string {
  return `// Generated by hive at review time. Deleted as soon as it has run.
import original from ${JSON.stringify(`./${config}`)};
const webServer = Array.isArray(original.webServer)
  ? original.webServer.map((server) => ({ ...server, reuseExistingServer: false }))
  : { ...original.webServer, reuseExistingServer: false };
export default { ...original, webServer };
`;
}

function saveEvidence(db: DB, taskId: string, file: string, caption: string): void {
  const destDir = join(evidenceDir(), taskId);
  mkdirSync(destDir, { recursive: true });
  const fileName = `proof_${Date.now()}_${newId()}.png`;
  const path = join(destDir, fileName);
  copyFileSync(file, path);
  const id = newId("ev");
  const url = `/evidence/${taskId}/${fileName}`;
  db.query(
    "INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, taskId, now(), "screenshot", path, url, caption, JSON.stringify({ rendered_at_review: true }));
  broadcast({ type: "evidence", evidence: { id, task_id: taskId, kind: "screenshot", url, caption, meta: { rendered_at_review: true } } });
}

// Render up to two screenshots for a task and store them as evidence rows.
// Never throws: every failure comes back as a reason for the caller to log.
export async function renderProofs(
  db: DB,
  task: { id: string; worktree_path?: string | null },
  files: string[],
  exec: Exec = defaultExec
): Promise<RenderOutcome> {
  const root = task.worktree_path ?? null;
  if (!root || !existsSync(root)) return { created: 0, reason: "no worktree checkout for this task" };

  const harness = findHarness(root, files);
  if ("reason" in harness) return { created: 0, reason: harness.reason };
  const fence = seatbelt(root);
  if ("reason" in fence) return { created: 0, reason: fence.reason };

  const routes = routesFromFiles(files);
  const runId = newId();
  const outDir = join(root, `.hive-proof-${runId}`);
  const specName = `hive-proof-${runId}.spec.ts`;
  const configName = `hive-proof-${runId}.config.ts`;
  const specPath = join(harness.dir, harness.testDir, specName);
  const configPath = join(harness.dir, configName);
  const specRel = join(harness.testDir, specName);
  mkdirSync(outDir, { recursive: true });

  // The outer `finally` is the only thing that deletes the proof directory, so
  // no path out of here can leak it into the worktree.
  try {
    let result;
    try {
      writeFileSync(specPath, specSource(routes, outDir));
      writeFileSync(configPath, configSource(harness.config));
      result = await exec([...fence.argv, "/usr/bin/env", "-i", `HOME=${process.env.HOME ?? ""}`, `PATH=${process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"}`, `TMPDIR=${process.env.TMPDIR ?? "/private/tmp"}`, "CI=1", "npx", "--no-install", "playwright", "test", specRel, "--config", configName, "--reporter=line", "--retries=0"], {
        cwd: harness.dir,
        timeoutMs: RENDER_TIMEOUT_MS,
      });
    } finally {
      rmSync(specPath, { force: true });
      rmSync(configPath, { force: true });
    }

    // A red run is not proof. It may have landed on an error page, a crash, or
    // a server that never came up, and that picture would go straight onto a
    // live Jira issue. Only a clean run is allowed to produce evidence.
    const detail = () => (result!.stderr || result!.stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
    if (result.code !== 0)
      return { created: 0, reason: `harness run failed (exit ${result.code}): ${detail()}` };

    const shots = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".png")).sort() : [];
    if (!shots.length) return { created: 0, reason: `harness passed but produced no image: ${detail()}` };
    shots.forEach((shot, i) =>
      saveEvidence(db, task.id, join(outDir, shot), `Rendered at review: ${routes[i] ?? routes[0]}`)
    );
    return { created: shots.length };
  } catch (e) {
    return { created: 0, reason: `render failed: ${String(e instanceof Error ? e.message : e)}` };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// Has hive already tried to render for this task? Checked by the caller BEFORE
// it reads the diff: re-reading a diff every poll to re-learn "already tried" is
// a network round trip per task per cycle.
export function renderProofAttempted(db: DB, taskId: string): boolean {
  return !!db
    .query(
      `SELECT 1 FROM events WHERE task_id = ? AND type = 'jira_sync'
         AND json_extract(payload, '$.action') = 'render_proof' LIMIT 1`
    )
    .get(taskId);
}

// Convenience for the sync loop: run once per task, whatever the outcome, and
// leave the reason in the ledger. Returns how many evidence rows were created.
export async function renderProofsOnce(
  db: DB,
  task: { id: string; worktree_path?: string | null },
  files: string[],
  exec: Exec = defaultExec
): Promise<number> {
  if (renderProofAttempted(db, task.id)) return 0;
  const outcome = await renderProofs(db, task, files, exec);
  writeEvent(db, {
    task_id: task.id,
    source: "jira-sync",
    type: "jira_sync",
    payload: { action: "render_proof", created: outcome.created, ...(outcome.reason ? { reason: outcome.reason } : {}) },
  });
  return outcome.created;
}
