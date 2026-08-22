// Dev-only rehearsal: prove hive re-adopts a live agent after herdr's registry
// forgets it. This is the ONE path that must work for an agent to survive a
// herdr registry wipe (a desktop-app restart), and until now it had fired ZERO
// times in production against 181 dead verdicts — i.e. it was never exercised.
//
// It drives the REAL herdr, but stays isolated from the live fleet: it spawns
// its own throwaway workspace of `node` panes, simulates the wipe per-agent with
// `agent rename --clear` (drops the registry record, the pane + process keep
// running), then calls hive's real Herdr.readopt() and asserts the agent
// resolves again. Never touches hive.db or any real task. Tears its workspace
// down at the end (panes only; there are no git worktrees to lose).
//
//   bun run scripts/readopt-rehearsal.ts          # 2 agents, both hint modes
//   REHEARSE_N=4 bun run scripts/readopt-rehearsal.ts
//
// Exit 0 = every agent re-adopted; exit 1 = a real gap in readopt.
import { Herdr, workspaceCreateArgv, tabCreateArgv, agentStartArgv, workspaceCloseArgv } from "../server/src/runtime/herdr.ts";

const N = Number(process.env.REHEARSE_N || 2);
const h = new Herdr();
const run = (h as any).run.bind(h) as (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
const j = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };
const fails: string[] = [];
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? "  ok  " : " FAIL "} ${msg}`); if (!cond) fails.push(msg); };

let workspaceId: string | null = null;
try {
  // 1) An isolated workspace so nothing here can collide with the real fleet.
  const ws = j((await run(workspaceCreateArgv("readopt-rehearsal"))).stdout);
  workspaceId = ws.result?.workspace?.workspace_id ?? ws.result?.root_pane?.workspace_id ?? ws.result?.workspace_id ?? null;
  if (!workspaceId) throw new Error("could not create rehearsal workspace");
  console.log(`workspace ${workspaceId}`);
  const cwd = process.cwd();

  for (let i = 0; i < N; i++) {
    const name = `readopt-rehearsal-${i}-${process.pid}`;
    const byTerminal = i % 2 === 0; // alternate the two readopt match paths
    console.log(`\n[agent ${name}] hint = ${byTerminal ? "terminalId (fast path)" : "cwd+process (fallback)"}`);

    // 2) Start a live "agent": a long-running node (non-login-shell → qualifies
    //    as an agent command for the cwd+process fallback).
    const tab = j((await run(tabCreateArgv(workspaceId, cwd, name))).stdout);
    const tabId = tab.result?.tab?.tab_id ?? tab.result?.pane?.tab_id ?? tab.result?.tab_id ?? null;
    await run(agentStartArgv({
      taskId: name, worktreePath: cwd, hiveUrl: "http://127.0.0.1:1", tabId,
      agentArgv: ["node", "-e", "setInterval(()=>{}, 1e9)"],
    }));

    // 3) Capture the binding hive would have persisted, from the live pane list.
    const pane = (await h.listPanes()).find((p) => p.label === name);
    ok(!!pane, "pane is registered and findable after start");
    if (!pane) continue;
    ok((await h.probe(name)).alive, "probe: alive before the wipe");

    // 4) Simulate the registry wipe for THIS agent only: clear the agent record
    //    AND (for the fallback case) the pane label, exactly as a real desktop
    //    restart does — leaving ONLY cwd + a running process to find it by. The
    //    pane and its node process keep running; `agent get <name>` stops resolving.
    await run(["agent", "rename", name, "--clear"]);
    if (!byTerminal) await run(["pane", "rename", pane.paneId, "--clear"]);
    ok(!(await h.probe(name)).alive, "probe: agent_not_found after the wipe (record gone)");
    ok(!(await h.confirmGone({ terminalId: pane.terminalId, cwd, tabId })),
       "confirmGone: NOT gone — the live pane is still there");

    // 5) The thing under test: hive re-adopts the live pane from the persisted hint.
    const hint = byTerminal
      ? { name, terminalId: pane.terminalId, cwd, tabId }
      : { name, terminalId: null, cwd, tabId };
    const re = await h.readopt(hint);
    ok(re.readopted, `readopt succeeded (${re.reason})`);
    ok((await h.probe(name)).alive, "probe: alive again — agent survived the wipe");
  }
} catch (e) {
  fails.push(`threw: ${(e as Error).message}`);
  console.error(e);
} finally {
  if (workspaceId) { await run(workspaceCloseArgv(workspaceId)).catch(() => {}); console.log(`\nclosed workspace ${workspaceId}`); }
  // Sweep any rehearsal workspace a prior crashed run leaked (created before its id was captured).
  try {
    const list = j((await run(["workspace", "list"])).stdout).result?.workspaces ?? [];
    for (const w of list) if (w.label === "readopt-rehearsal" && w.workspace_id !== workspaceId)
      await run(workspaceCloseArgv(w.workspace_id)).catch(() => {});
  } catch {}
}

console.log(`\n${fails.length ? `FAIL (${fails.length})` : "PASS"} — readopt ${fails.length ? "has a gap" : "recovers a wiped agent"}`);
process.exit(fails.length ? 1 : 0);
