// Live verification of the RE-ADOPTION primitive (#1103) against the real herdr
// server. Stubbed tests can only prove hive calls the right commands; this
// proves herdr actually behaves the way re-adoption depends on. Creates its own
// throwaway workspace and closes it again — it never touches the hive fleet.
//
//   bun run scripts/herdr-readopt-verify.ts 2>&1 | tee docs/evidence/herdr-readopt-verification.txt
import { defaultExec } from "../server/src/exec.ts";
import { HERDR_BIN, parsePaneList, paneRunsAgentCommand, parseAgentProbe, parsePaneId } from "../server/src/runtime/herdr.ts";

const BIN = HERDR_BIN;
const NAME = `readopt-verify-${Math.random().toString(16).slice(2, 8)}`;

const log = (...a: unknown[]) => console.log(...a);
const hr = (s: string) => log(`\n===== ${s} =====`);
let failures = 0;
const check = (b: boolean, msg: string) => {
  if (!b) failures++;
  log(`${b ? "PASS" : "FAIL"} ${msg}`);
};
async function h(argv: string[]) {
  const r = await defaultExec([BIN, ...argv]);
  log(`$ herdr ${argv.join(" ")}\n  code=${r.code} stdout=${r.stdout.trim().slice(0, 400)} stderr=${r.stderr.trim().slice(0, 200)}`);
  return r;
}
const json = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

hr("setup: throwaway workspace + tab (root pane is a login SHELL)");
const ws = json((await h(["workspace", "create", "--label", `hive-${NAME}`, "--no-focus"])).stdout).result?.workspace?.workspace_id;
if (!ws) {
  log("FAIL could not create a scratch workspace — is herdr running?");
  process.exit(1);
}
try {
  const tab = json((await h(["tab", "create", "--workspace", ws, "--cwd", "/tmp", "--label", NAME, "--no-focus"])).stdout).result;
  const tabId = tab?.tab?.tab_id;
  const shellPane = tab?.root_pane?.pane_id;

  hr("setup: an 'agent' pane in the SAME tab at the SAME cwd (what a fleet tab looks like)");
  await h(["agent", "start", NAME, "--cwd", "/tmp", "--tab", tabId, "--no-focus", "--", "sleep", "600"]);
  const agentPane = parsePaneId((await h(["agent", "get", NAME])).stdout);
  check(!!agentPane && agentPane !== shellPane, `two panes in tab ${tabId}: shell ${shellPane}, agent ${agentPane}`);

  hr("A. pane list carries cwd + STABLE terminal_id for every pane");
  const panes = parsePaneList((await h(["pane", "list"])).stdout).filter((p) => p.tabId === tabId);
  check(panes.length === 2, `both panes visible (${panes.length})`);
  check(panes.every((p) => p.cwd === "/private/tmp" || p.cwd === "/tmp"), "both panes report the same cwd — cwd ALONE cannot pick the agent");
  check(panes.every((p) => !!p.terminalId), "every pane carries a terminal_id");

  hr("B. process-info separates the agent pane from the tab's shell pane");
  const runs = async (paneId: string) => paneRunsAgentCommand((await h(["pane", "process-info", "--pane", paneId])).stdout);
  check((await runs(agentPane!)) === true, "agent pane: running a command");
  check((await runs(shellPane)) === false, "shell pane: a login shell, never re-adopted");

  hr("C. the wipe: with the name gone, `agent get` is agent_not_found (what hive sees after a desktop-app restart)");
  await h(["agent", "rename", NAME, "--clear"]);
  const wiped = await h(["agent", "get", NAME]);
  check(/agent_not_found/.test(`${wiped.stdout}${wiped.stderr}`), "target no longer resolves");

  hr("D. re-adoption: report-agent + rename put the RUNNING pane back under its name");
  await h(["pane", "report-agent", agentPane!, "--source", "hive", "--agent", NAME, "--state", "unknown"]);
  await h(["agent", "rename", NAME, NAME]);
  const back = await h(["agent", "get", NAME]);
  const probe = parseAgentProbe(back.stdout);
  check(probe.alive, "`agent get <name>` resolves again");
  check(json(back.stdout).result?.agent?.pane_id === agentPane, "…and it is the same live pane, not a new session");

  hr("E. the binding SURVIVES Claude Code's own integration re-reporting on that pane");
  await h(["pane", "report-agent", agentPane!, "--source", "claude-code", "--agent", "claude", "--state", "idle"]);
  const after = json((await h(["agent", "get", NAME])).stdout).result?.agent;
  check(after?.name === NAME, "name pinned by rename survives a foreign source's report");
  check(after?.agent === "claude", "…while the detected agent + status are handed back to the real integration");

  hr("F. hive can steer the re-adopted target again");
  const sent = await h(["agent", "send", NAME, "hive readopt verification"]);
  check(sent.code === 0 && !/error/.test(sent.stdout), "`agent send <name>` is accepted");
} finally {
  hr("teardown");
  await h(["workspace", "close", ws]);
}

hr(failures ? `RESULT: ${failures} FAILURE(S)` : "RESULT: all checks passed");
process.exit(failures ? 1 : 0);
