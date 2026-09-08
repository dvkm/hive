// `hive doctor`: the prerequisites hive needs, each with the fix. Without
// Herdr or an agent CLI the board still renders but nothing ever spawns, and
// that silence is the first thing a new install hits. The same checks back
// GET /api/doctor so the web app can say it too. Pure over injected probes so
// tests never touch the machine.
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hiveHome } from "./db.ts";
import { discoverHerdrBin, workspaceListArgv } from "./runtime/herdr.ts";

export type Check = { name: string; ok: boolean; required: boolean; detail: string; fix: string | null };

export type DoctorProbes = {
  which: (name: string) => string | null;
  exists: (path: string) => boolean;
  herdrAlive: (bin: string) => boolean;
  writable: (dir: string) => boolean;
  env: NodeJS.ProcessEnv;
};

const DEFAULT_PROBES: DoctorProbes = {
  which: (name) => Bun.which(name),
  exists: existsSync,
  herdrAlive: (bin) => {
    try {
      const r = Bun.spawnSync([bin, ...workspaceListArgv()], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  },
  writable: (dir) => {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  env: process.env,
};

export function runDoctor(probes: Partial<DoctorProbes> = {}): Check[] {
  const p = { ...DEFAULT_PROBES, ...probes };
  const found = (name: string) => {
    const path = p.which(name);
    return path && p.exists(path) ? path : null;
  };
  const checks: Check[] = [];

  const git = found("git");
  checks.push({ name: "git", ok: !!git, required: true, detail: git ?? "not found", fix: git ? null : "install git (https://git-scm.com)" });

  const herdrBin = discoverHerdrBin(p.env, process.platform, p.which, p.exists);
  const herdrFound = p.exists(herdrBin);
  checks.push({
    name: "herdr",
    ok: herdrFound,
    required: true,
    detail: herdrFound ? herdrBin : "not installed: agents cannot spawn",
    fix: herdrFound ? null : "install Herdr from https://herdr.dev (or set HERDR_BIN)",
  });
  const alive = herdrFound && p.herdrAlive(herdrBin);
  checks.push({
    name: "herdr daemon",
    ok: alive,
    required: true,
    detail: alive ? "running" : herdrFound ? "not responding: agents cannot spawn" : "skipped (herdr not installed)",
    fix: alive ? null : "start Herdr, then run `hive doctor` again",
  });

  // Same fallback paths planner.ts's claudeBin() walks; not imported because
  // planner pulls in the whole api graph and the CLI runs this offline.
  const home = p.env.HOME || homedir();
  const claude = [p.env.HIVE_CLAUDE_BIN, found("claude"), join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
    .find((c): c is string => !!c && p.exists(c)) ?? null;
  const codex = found("codex");
  const agents = [claude && `claude ${claude}`, codex && `codex ${codex}`].filter(Boolean).join(", ");
  checks.push({
    name: "agent CLI",
    ok: !!(claude || codex),
    required: true,
    detail: agents || "neither claude nor codex found",
    fix: claude || codex ? null : "install Claude Code (https://claude.com/product/claude-code) or Codex (https://developer.openai.com/codex/cli/)",
  });

  const gh = found("gh");
  checks.push({ name: "gh", ok: !!gh, required: false, detail: gh ?? "not found: PR review and merge automation off", fix: gh ? null : "install GitHub CLI (https://cli.github.com) and run `gh auth login`" });

  const dataDir = hiveHome();
  const w = p.writable(dataDir);
  checks.push({ name: "data dir", ok: w, required: true, detail: w ? dataDir : `${dataDir} is not writable`, fix: w ? null : "fix permissions on that directory, or point HIVE_HOME somewhere writable" });

  return checks;
}

export function doctorOk(checks: Check[]): boolean {
  return checks.every((c) => c.ok || !c.required);
}

export function formatDoctor(checks: Check[]): string {
  return checks
    .map((c) => `${c.ok ? "ok  " : c.required ? "FAIL" : "warn"}  ${c.name.padEnd(13)} ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ""}`)
    .join("\n");
}
