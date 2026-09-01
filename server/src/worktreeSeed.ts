// HIVE-355: a fresh worktree is missing the two things that make it slow to
// start on, and git will never hand over either of them.
//
//   1. Untracked config the app needs to boot — .env, .env.local, config.env.
//      Gitignored by design, so `worktree create` gives an agent a checkout
//      that cannot run. (Conductor's most-reported complaint is exactly this.)
//   2. The expensive post-setup state — node_modules. Reinstalling it per
//      worktree is the single biggest slice of spawn-to-first-edit.
//
// Both already exist in the MAIN checkout, so seed from there: copy (1),
// CLONE (2). On APFS/btrfs a clone is copy-on-write, so a 400MB node_modules
// lands in milliseconds and costs no disk until something writes to it. The
// clone is invalidated by lockfile mismatch, which is the only way a branch
// can legitimately need different deps.
//
// Runs after `worktree create` and BEFORE config.setup_argv, so a project's
// own setup hook sees the warm state and no-ops (hive's own `wt.sh up` already
// short-circuits on `[ -d node_modules ]`). Everything here is best-effort: a
// seed that fails is a slow spawn, never a broken one, so nothing throws.
import { existsSync, mkdirSync, cpSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { Exec } from "./exec.ts";
import { defaultExec } from "./exec.ts";

export interface SeedResult {
  seeded: string[]; // untracked files copied in
  warmed: string[]; // directories cloned in
  // Expected, correct outcomes. A lockfile that genuinely changed, a file the
  // worktree already owns: the design working, so these stay quiet.
  skipped: { path: string; reason: string }[];
  // The config names something that is not there. Never quiet: from the agent's
  // side a worktree that was never warmed looks exactly like a warm one, right
  // up until it fails somewhere unrelated. Surfaced as its own `_failed` event.
  misconfigured: { path: string; reason: string }[];
  ms: number;
}

// Copy-on-write clone flags per platform. macOS `cp -c` FAILS outright when the
// filesystem cannot clone, so the caller falls back; Linux's `--reflink=auto`
// degrades to a plain copy on its own. Anything else takes the fs fallback.
// A big enough budget that even a real byte copy finishes; defaultExec's 60s
// default would kill a large tree half-written.
const CLONE_TIMEOUT_MS = 300_000;
const CLONE_ARGV: string[] | null =
  process.platform === "darwin" ? ["cp", "-Rc"] : process.platform === "linux" ? ["cp", "-R", "--reflink=auto"] : null;

// Keep a config-supplied path inside the tree it claims to be relative to.
// projects.config is already an RCE surface (see projectConfig.ts), so this is
// not the security boundary — it is here so a typo'd "../.." seeds a spawn with
// somebody else's files instead of failing loudly.
function insideTree(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const full = resolve(root, rel);
  const back = relative(root, full);
  return back && !back.startsWith("..") ? full : null;
}

// Throw away a clone that did not finish. Only ever called on `dst`, which
// insideTree has already proved sits under this task's own worktree.
function discard(dst: string): void {
  rmSync(dst, { recursive: true, force: true });
}

async function cloneDir(src: string, dst: string, exec: Exec): Promise<void> {
  mkdirSync(dirname(dst), { recursive: true });
  if (CLONE_ARGV) {
    const r = await exec([...CLONE_ARGV, src, dst], { timeoutMs: CLONE_TIMEOUT_MS });
    if (r.code === 0) return;
    // Failed or killed part-way. A half-copied node_modules is worse than none,
    // and the "already present" guard would keep it forever. Start clean.
    discard(dst);
  }
  // ponytail: a real byte copy, so no faster than the install it replaces on a
  // filesystem without reflinks. Correct everywhere, which is what matters.
  cpSync(src, dst, { recursive: true });
}

// Same bytes on both sides? That is the whole invalidation rule: a branch that
// did not touch the lockfile cannot need different deps, and one that did must
// run the real install. Compared by content, not mtime — a fresh worktree
// checkout stamps every file with "now".
// A missing lockfile and a changed one both mean "do not clone", but they are
// not the same event: one is a config that names a file nobody has, the other is
// the rule doing its job. Returning which lets the caller be loud about the
// first and quiet about the second.
function lockVerdict(repoPath: string, worktreePath: string, lock: string): "match" | "differs" | "missing" {
  const a = insideTree(repoPath, lock);
  const b = insideTree(worktreePath, lock);
  if (!a || !b) return "missing";
  if (!existsSync(a) || !existsSync(b)) return "missing";
  return readFileSync(a).equals(readFileSync(b)) ? "match" : "differs";
}

// config.worktree_seed: globs of untracked files to copy from the main checkout.
// config.worktree_warm: [{dir, lock?}] directories to clone when `lock` matches.
export async function seedWorktree(
  repoPath: string,
  worktreePath: string,
  config: { worktree_seed?: unknown; worktree_warm?: unknown },
  exec: Exec = defaultExec
): Promise<SeedResult> {
  const started = Date.now();
  const out: SeedResult = { seeded: [], warmed: [], skipped: [], misconfigured: [], ms: 0 };
  const patterns = Array.isArray(config.worktree_seed) ? config.worktree_seed.map(String) : [];
  const warm = Array.isArray(config.worktree_warm) ? config.worktree_warm : [];

  const unmatched: string[] = [];
  for (const pattern of patterns) {
    let matched = 0;
    try {
      // Bun.Glob scans the main checkout, so the allowlist selects real files
      // rather than trusting the pattern to be a path. `dot: true` because
      // every file this exists for starts with one.
      for await (const rel of new Bun.Glob(pattern).scan({ cwd: repoPath, dot: true, onlyFiles: true })) {
        matched++;
        const src = insideTree(repoPath, rel);
        const dst = insideTree(worktreePath, rel);
        if (!src || !dst) {
          out.misconfigured.push({ path: rel, reason: "escapes the worktree" });
          continue;
        }
        // Never clobber. Anything already there is either tracked content the
        // branch owns, or a file setup already wrote — both outrank the copy.
        if (existsSync(dst)) {
          out.skipped.push({ path: rel, reason: "already present in worktree" });
          continue;
        }
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        out.seeded.push(rel);
      }
    } catch (e: any) {
      out.misconfigured.push({ path: pattern, reason: String(e?.message ?? e).slice(0, 200) });
      continue;
    }
    if (!matched) {
      unmatched.push(pattern);
      out.skipped.push({ path: pattern, reason: "no match in main checkout" });
    }
  }
  // A pattern that matched nothing is usually fine: projects list `.env` and
  // `.env.local` together and only one exists. But an allowlist where NOTHING
  // matched is a config nobody is honouring, and staying quiet about it hands
  // the agent a worktree that cannot boot. Loud only for that.
  if (patterns.length && unmatched.length === patterns.length)
    out.misconfigured.push({ path: patterns.join(", "), reason: "no worktree_seed pattern matched anything in the main checkout" });

  for (const entry of warm) {
    const dir = String((entry as any)?.dir ?? "");
    const lock = (entry as any)?.lock ? String((entry as any).lock) : null;
    const src = insideTree(repoPath, dir);
    const dst = insideTree(worktreePath, dir);
    if (!dir || !src || !dst) {
      out.misconfigured.push({ path: dir || "(empty)", reason: "escapes the worktree" });
      continue;
    }
    // The config names a directory to warm from, and it is not there. Nothing
    // will ever be warmed from this entry, on this spawn or any other.
    if (!existsSync(src)) {
      out.misconfigured.push({ path: dir, reason: "named in worktree_warm but not built in the main checkout" });
      continue;
    }
    if (existsSync(dst)) {
      out.skipped.push({ path: dir, reason: "already present in worktree" });
      continue;
    }
    if (lock) {
      const verdict = lockVerdict(repoPath, worktreePath, lock);
      // Missing lockfile: the entry can never validate, so the clone is dead
      // config rather than a branch that changed its deps. Say so.
      if (verdict === "missing") {
        out.misconfigured.push({ path: dir, reason: `lock file ${lock} is missing, so ${dir} can never be warmed` });
        continue;
      }
      // The rule doing its job — this branch really did change its deps.
      if (verdict === "differs") {
        out.skipped.push({ path: dir, reason: `${lock} differs from main checkout` });
        continue;
      }
    }
    try {
      await cloneDir(src, dst, exec);
      out.warmed.push(dir);
    } catch (e: any) {
      discard(dst); // the fs fallback can throw mid-copy too
      out.misconfigured.push({ path: dir, reason: String(e?.message ?? e).slice(0, 200) });
    }
  }

  out.ms = Date.now() - started;
  return out;
}
