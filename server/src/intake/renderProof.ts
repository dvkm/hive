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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// TanStack Router's `src/routes/` tree, where the file name is part of the URL
// and not a fixed `page.tsx`. `_page/pricing.tsx` is `/pricing`: segments that
// start with an underscore are pathless layouts, `index` means the parent path,
// and a dotted file name (`posts.index.tsx`) is the flat spelling of nesting.
// Returns null when the file is not a TanStack route, or is one hive must skip:
// a `$param` route it has no id for, or a Storybook story.
function tanstackRoute(file: string): string | null {
  const m = file.match(/(?:^|\/)src\/routes\/(.*)$/);
  if (!m) return null;
  const parts = m[1].split("/");
  const name = parts[parts.length - 1] ?? "";
  if (/\.stories\.[cm]?[jt]sx?$/.test(name)) return null;
  const segments = [
    ...parts.slice(0, -1),
    ...name.replace(/\.[cm]?[jt]sx?$/, "").split("."),
  ];
  if (segments.some((s) => s.includes("$"))) return null;
  const kept = segments.filter((s) => s && s !== "index" && !s.startsWith("_"));
  return `/${kept.join("/")}`.replace(/\/+$/, "") || "/";
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
    const tanstack = tanstackRoute(file);
    if (tanstack) {
      if (!routes.includes(tanstack)) routes.push(tanstack);
      if (routes.length === MAX_ROUTES) break;
      continue;
    }
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
  const dead = [];
  page.on("requestfailed", (r) => {
    if (!CRITICAL.has(r.resourceType())) return;
    if (/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) return;
    dead.push(r.url());
  });
  const response = await page.goto(${JSON.stringify(route)});
  await page.waitForLoadState("networkidle").catch(() => {});
  if (response && !response.ok()) throw new Error("page answered HTTP " + response.status());
  const broken = dead.filter(sameOrigin(page.url()));
  if (broken.length) throw new Error("page could not load its data, " + broken.length + " request(s) failed: " + broken.slice(0, 3).join(" "));
  const overlay = await devOverlay(page);
  if (overlay) throw new Error("page is showing a dev-server error overlay: " + overlay);
  await page.screenshot({ path: ${JSON.stringify(join(outDir, `proof-${i + 1}.png`))} });
});`
    )
    .join("\n");
  // A page that renders its own error boundary still answers HTTP 200 and still
  // screenshots cleanly, so exit code alone is not enough: a single-page app
  // whose API is unreachable from the sandbox produces a picture of "something
  // went wrong" and hive would post it to a live ticket as proof. A non-2xx
  // document, or a failed request the page actually needed, fails the shot
  // instead, so the ticket falls back to text with a reason a person can act on.
  //
  // "Actually needed" is a narrow test on purpose, because the seatbelt above
  // allows localhost and denies the rest of the network. Every third-party
  // request therefore fails on EVERY run: analytics beacons, font CDNs, error
  // reporters. Failing the shot on those would mean render_proof never produces
  // a picture for any real app, which is a worse bug than the one it prevents.
  // So a failure only counts when all three hold:
  //   - it is same-origin, i.e. served by the app's own dev server, the only
  //     origin that CAN succeed inside the fence,
  //   - it is a document, script, xhr or fetch, the kinds a page needs to
  //     render, not an image, font, beacon or stylesheet,
  //   - it was not merely cancelled, which is how a speculative prefetch and a
  //     superseded navigation both end up in `requestfailed`.
  //
  // Chromium's own helper sandbox cannot nest inside the seatbelt: its GPU
  // process dies on launch and takes the run with it. The outer seatbelt is the
  // fence that matters here, so the inner one is turned off.
  const launch = `test.use({ launchOptions: { chromiumSandbox: false, args: ["--disable-gpu"] } });`;
  // The remaining way a broken page looks healthy: a dev server that answers 200
  // with a compile error painted over the app. This is not hypothetical — the
  // first real run of this code against a real checkout screenshotted a Vite
  // overlay reading `Failed to resolve import`, with a 200 and no failed
  // request, which is precisely the picture that must never reach a ticket.
  // Both Vite and Next mount their overlay as a custom element, so one DOM
  // query catches it, and the overlay's own text becomes the reason.
  const overlay = `const OVERLAYS = ["vite-error-overlay", "nextjs-portal [data-nextjs-dialog]", "#webpack-dev-server-client-overlay"];
const devOverlay = async (page) => {
  for (const selector of OVERLAYS) {
    const found = page.locator(selector).first();
    if (!(await found.count())) continue;
    // Vite paints the overlay inside a shadow root, so textContent on the host
    // element is empty and the reason would be a bare tag name. Reach into the
    // shadow root when there is one, so the director gets the compile error.
    const text = await found
      .evaluate((el) => (el.shadowRoot?.textContent || el.textContent || "").replace(/\\s+/g, " ").trim())
      .catch(() => "");
    return (text || selector).slice(0, 200);
  }
  return null;
};`;
  const helpers = `${overlay}
const CRITICAL = new Set(["document", "script", "xhr", "fetch"]);
const sameOrigin = (pageUrl) => {
  let origin = null;
  try { origin = new URL(pageUrl).origin; } catch {}
  return (url) => {
    if (!origin) return false;
    try { return new URL(url).origin === origin; } catch { return false; }
  };
};`;
  return `// Generated by hive at review time. Deleted as soon as it has run.\nimport { test } from "@playwright/test";\n${launch}\n${helpers}\n${shots}\n`;
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

// The repo's OWN Playwright binary, or a reason.
//
// This used to run `npx --no-install playwright test`. When the worktree has no
// node_modules — which is every fresh hive worktree until someone installs —
// npx does not stop, it walks PATH and runs whatever `playwright` it finds on
// the host. On this Mac that is Homebrew's, a different package and a different
// version, whose CLI has no `test` command at all. So the whole point of the
// design ("run the TARGET repo's own harness") quietly became "run some binary
// off the host", and the reason a person got back was `unknown command 'test'`.
//
// Resolve it ourselves instead: walk up from the harness directory to the
// worktree root looking for node_modules/.bin/playwright, and refuse if there
// is none. Refusing is the safe half of the trust story — an uninstalled repo
// gets a reason it can act on rather than a run of a stranger's browser.
function playwrightBin(dir: string, root: string): string | { reason: string } {
  for (let at = resolve(dir); ; at = resolve(at, "..")) {
    const bin = join(at, "node_modules", ".bin", "playwright");
    if (existsSync(bin)) return bin;
    if (at === resolve(root) || at === resolve(at, "..")) break;
  }
  return {
    reason: `${relative(root, dir) || "."}/ has no installed Playwright (node_modules/.bin/playwright), and hive will not run a browser harness off the host PATH`,
  };
}

// ---- borrowed dependencies -----------------------------------------------
// A fresh hive worktree has no node_modules, so playwrightBin above refuses and
// the render never happens. Installing them here is not an option: the run is
// fenced by a seatbelt that denies the network, and an install outside the fence
// would execute the PR branch's own postinstall scripts unfenced, which is the
// one thing the trust story is built to avoid.
//
// So borrow instead. Every task worktree is cut from a main checkout that
// already has the deps installed, and linking costs no network and runs no repo
// code.
//
// node_modules is created as a REAL directory holding one symlink per entry,
// never as a single symlink to the main checkout's. Vite writes its dependency
// cache into node_modules/.vite, and the seatbelt denies every write outside
// the worktree, so a wholly symlinked node_modules would kill the dev server on
// startup.
//
// The links are removed after the run. Leaving a branch wired to another
// checkout's dependencies is how an agent later gets a mystery build: the
// branch may add or bump a package, and `wt.sh up`-style setup hooks skip the
// install when node_modules already exists.
//
// ponytail: no version check against the branch's lockfile. A dependency the
// branch just added is missing, so its dev server fails and the task falls back
// to text with the reason — the same quiet degrade as today, and cheaper than
// resolving a lockfile hive does not own.

// The checkout this linked worktree was cut from. A linked worktree's `.git` is
// a FILE reading `gitdir: <repo>/.git/worktrees/<name>`; anything else (a real
// repo, a bare directory) has no main checkout to borrow from.
function mainCheckout(root: string): string | null {
  let text = "";
  try {
    text = readFileSync(join(root, ".git"), "utf8");
  } catch {
    return null;
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
  const main = gitdir ? /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir)?.[1] : null;
  return main && existsSync(main) ? main : null;
}

// Build caches that live inside node_modules. These are NOT linked: a dev
// server rewrites them on startup, and a link would send that write to the main
// checkout, which the seatbelt denies. Vite dies on exactly this
// ("EPERM: operation not permitted, unlink node_modules/.vite/deps/..."), so the
// worktree gets its own empty cache and Vite fills it.
const DEV_CACHES = [".vite", ".vite-temp", ".cache"];

// Link the main checkout's installed packages into every package directory from
// the harness up to the worktree root that has none. Returns an undo that
// deletes exactly what it created, and nothing else.
export function borrowDeps(dir: string, root: string): () => void {
  const made: string[] = [];
  const undo = () => made.forEach((path) => rmSync(path, { recursive: true, force: true }));
  const main = mainCheckout(root);
  if (!main) return undo;
  for (let at = resolve(dir); ; at = resolve(at, "..")) {
    const into = join(at, "node_modules");
    const from = join(main, relative(root, at), "node_modules");
    if (existsSync(join(at, "package.json")) && !existsSync(into) && existsSync(from)) {
      try {
        mkdirSync(into, { recursive: true });
        made.push(into);
        for (const entry of readdirSync(from)) {
          if (DEV_CACHES.includes(entry)) continue;
          symlinkSync(join(from, entry), join(into, entry));
        }
      } catch {
        undo(); // a half-linked node_modules is worse than none
        return () => {};
      }
    }
    if (at === resolve(root) || at === resolve(at, "..")) break;
  }
  return undo;
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
  const unborrow = borrowDeps(harness.dir, root);
  const playwright = playwrightBin(harness.dir, root);
  if (typeof playwright !== "string") {
    unborrow();
    return { created: 0, reason: playwright.reason };
  }

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
      result = await exec([...fence.argv, "/usr/bin/env", "-i", `HOME=${process.env.HOME ?? ""}`, `PATH=${process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"}`, `TMPDIR=${process.env.TMPDIR ?? "/private/tmp"}`, "CI=1", playwright, "test", specRel, "--config", configName, "--reporter=line", "--retries=0"], {
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
    // The reason is the only thing a person gets when nothing rendered, so it
    // has to name the real failure. Playwright puts that on stdout while node
    // puts its deprecation warnings on stderr, and reading stderr first buried
    // "page could not load its data" under "module.register() is deprecated".
    // Read both, drop the noise, and prefer the line that carries the error.
    const detail = () => {
      const lines = `${result!.stdout ?? ""}\n${result!.stderr ?? ""}`
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !/DeprecationWarning|trace-deprecation|^\(node:\d+\)/.test(line));
      const errors = lines.filter((line) => /Error:/.test(line));
      return (errors.length ? errors : lines.slice(-3)).join(" ").slice(0, 300);
    };
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
    unborrow();
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
