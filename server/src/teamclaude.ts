// TeamClaude integration. TeamClaude (`/opt/homebrew/bin/teamclaude`) is a
// local proxy that routes Anthropic API calls across multiple Claude accounts.
// Its supported hook is environment variables: `teamclaude env` prints
// `export K=V` / `unset K` lines (proxy address + CA cert in MITM mode, or an
// ANTHROPIC_BASE_URL in base-URL mode). Hive injects those into every claude
// it starts — planner `claude -p` subprocesses and herdr pane agents — so all
// fleet traffic gets account-balanced.
//
// Fail-open by design: if the teamclaude binary is missing, `env` fails, or
// the proxy isn't actually listening, return null and claude runs direct.
// Injecting proxy vars that point at a dead port would brick every agent.
// Kill switch: HIVE_TEAMCLAUDE=0.
import { defaultExec, type Exec } from "./exec.ts";

export type TeamclaudeEnv = { set: Record<string, string>; unset: string[] };

// Per-project opt-in for WORKER agents: config.agent = "teamclaude" runs the
// claude binary with the proxy env injected; plain "claude" runs direct.
// (Hive's own `claude -p` subprocesses — planner/review/drift/explain — always
// prefer the proxy when it's up; HIVE_TEAMCLAUDE=0 turns that off.)
export function usesTeamclaude(config: any): boolean {
  return config?.agent === "teamclaude";
}

// Parse `teamclaude env` output. Only export/unset lines matter; comments and
// blank lines are skipped. Values are printed unquoted today; strip a matching
// quote pair defensively.
export function parseTeamclaudeEnv(stdout: string): TeamclaudeEnv {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const line of stdout.split("\n")) {
    const ex = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (ex) {
      set[ex[1]] = ex[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      continue;
    }
    const un = line.match(/^unset ([A-Za-z_][A-Za-z0-9_]*)$/);
    if (un) unset.push(un[1]);
  }
  return { set, unset };
}

// The URL claude's traffic would be sent through — must be listening or we
// don't inject anything.
export function proxyUrl(env: TeamclaudeEnv): string | null {
  return env.set.HTTPS_PROXY ?? env.set.ANTHROPIC_BASE_URL ?? null;
}

const TTL_MS = 30_000;
let cache: { at: number; env: TeamclaudeEnv | null } | null = null;

export function resetTeamclaudeCache(): void {
  cache = null;
}

async function probe(exec: Exec): Promise<TeamclaudeEnv | null> {
  const r = await exec(["teamclaude", "env"], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  const env = parseTeamclaudeEnv(r.stdout);
  const url = proxyUrl(env);
  if (!url) return null;
  try {
    // Any HTTP response (even 404) proves the proxy is up; refused/timeout throws.
    const u = new URL(url);
    await fetch(`http://${u.hostname}:${u.port || 80}/`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return null;
  }
  return env;
}

// Cached (30s TTL) so per-spawn cost is nil while a proxy restart or shutdown
// is still picked up quickly.
export async function teamclaudeEnv(exec: Exec = defaultExec): Promise<TeamclaudeEnv | null> {
  if (process.env.HIVE_TEAMCLAUDE === "0") return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.env;
  const env = await probe(exec);
  cache = { at: Date.now(), env };
  return env;
}

// Merge teamclaude routing into a spawn env map. Base entries win nothing:
// teamclaude's exports overwrite (that's the point), and its `unset` names are
// removed (e.g. a stray ANTHROPIC_BASE_URL would bypass the MITM proxy).
export function applyTeamclaudeEnv(
  base: Record<string, string | undefined>,
  tc: TeamclaudeEnv | null
): Record<string, string | undefined> {
  if (!tc) return base;
  const merged = { ...base, ...tc.set };
  for (const k of tc.unset) delete merged[k];
  return merged;
}
