import { expect, test } from "bun:test";
import { CodexStreamRuntime, execArgv, itemLine, resumeArgv } from "../src/runtime/codexStream.ts";

// A stand-in for one `codex exec` process: a controllable stdout, a resolvable
// exit. Lets the driver's status machine and turn queue run with no model call.
function fakeProc(argv: string[], killed: string[]) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const enc = new TextEncoder();
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  return {
    argv,
    proc: { pid: 4242, stdout, stderr: null, exited, write: () => {}, end: () => {}, kill: () => { killed.push(argv.join(" ")); controller.close(); resolveExit(137); } },
    emit: (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")),
    exit: (code: number) => { controller.close(); resolveExit(code); },
  };
}

// Every spawned turn, newest last, plus the argvs the runtime asked for.
function fakeCodex() {
  const turns: ReturnType<typeof fakeProc>[] = [];
  const killed: string[] = [];
  return {
    turns,
    killed,
    last: () => turns[turns.length - 1],
    spawn: (argv: string[]) => {
      const t = fakeProc(argv, killed);
      turns.push(t);
      return t.proc;
    },
  };
}

const PANE_ARGV = ["codex", "--sandbox", "workspace-write", "--model", "gpt-5", "Fix the parser."];

test("the brief runs as one exec turn, the thread id is captured, a steer resumes the same thread after the turn exits", async () => {
  const codex = fakeCodex();
  const rt = new CodexStreamRuntime((argv) => codex.spawn(argv), null);
  await rt.spawn({ taskId: "t1", cwd: "/tmp/wt", hiveUrl: "http://127.0.0.1:1", hiveCli: "hive", brief: "Fix the parser.", argv: PANE_ARGV });

  expect(codex.turns.length).toBe(1);
  expect(codex.last().argv).toEqual(["codex", "exec", "--json", "--sandbox", "workspace-write", "--model", "gpt-5", "Fix the parser."]);
  expect(rt.probe("t1")).toEqual({ alive: true, status: "working" });
  expect(rt.list()).toEqual([{ name: "t1", tabId: null }]);

  codex.last().emit({ type: "thread.started", thread_id: "th-1" });
  codex.last().emit({ type: "turn.started" });
  codex.last().emit({ type: "item.completed", item: { item_type: "agent_message", text: "Reading the parser first." } });
  codex.last().emit({ type: "item.completed", item: { item_type: "command_execution", command: "bun test" } });
  await Bun.sleep(10);
  expect(rt.sessionId("t1")).toBe("th-1");
  expect(rt.probe("t1").status).toBe("working");

  // A steer mid-turn is queued: one thread cannot hold two live turns.
  expect(rt.send("t1", "Also fix the tests.").code).toBe(0);
  await Bun.sleep(10);
  expect(codex.turns.length).toBe(1);

  codex.last().emit({ type: "turn.completed" });
  expect((await rt.wait("t1", "idle", 1000)).code).toBe(0);
  expect(rt.probe("t1").status).toBe("idle");

  const said = rt.read("t1", 20);
  expect(said).toContain("Reading the parser first.");
  expect(said).toContain("▸ command_execution: bun test");

  // The turn's process exits; the queued steer starts the next turn on the same thread.
  codex.last().exit(0);
  await Bun.sleep(10);
  expect(codex.turns.length).toBe(2);
  expect(codex.last().argv).toEqual(["codex", "exec", "resume", "th-1", "--json", "--sandbox", "workspace-write", "--model", "gpt-5", "Also fix the tests."]);
  expect(rt.probe("t1").status).toBe("working");
  expect((await rt.wait("t1", "idle", 20)).code).toBe(1); // still working: times out like herdr's wait

  // `resume` re-announces the thread it just reopened; the id must not drift.
  codex.last().emit({ type: "thread.started", thread_id: "th-1" });
  await Bun.sleep(10);
  expect(rt.sessionId("t1")).toBe("th-1");
});

test("a failed turn is reported and stays resumable; close kills the live turn and drops it from the list", async () => {
  const codex = fakeCodex();
  const rt = new CodexStreamRuntime((argv) => codex.spawn(argv), null);
  await rt.spawn({ taskId: "t2", cwd: "/tmp/wt2", hiveUrl: "http://127.0.0.1:1", hiveCli: "hive", brief: "Ship it.", argv: PANE_ARGV });

  codex.last().emit({ type: "thread.started", thread_id: "th-2" });
  codex.last().emit({ type: "turn.started" });
  codex.last().emit({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
  expect((await rt.wait("t2", "idle", 1000)).code).toBe(0);
  expect(rt.probe("t2")).toEqual({ alive: true, status: "idle" });
  expect(rt.read("t2", 20)).toContain("stream disconnected before completion");

  expect(rt.close("t2")).toEqual({ closed: true, via: "protocol" });
  expect(codex.killed.length).toBe(1);
  expect(rt.has("t2")).toBe(false);
  expect(rt.list()).toEqual([]);
  expect(rt.probe("t2")).toEqual({ alive: false, status: "unknown" });
  expect(rt.send("t2", "x").code).toBe(1);
});

test("a first turn that dies before naming a thread is gone, not idle", async () => {
  const codex = fakeCodex();
  const rt = new CodexStreamRuntime((argv) => codex.spawn(argv), null);
  await rt.spawn({ taskId: "t3", cwd: "/tmp/wt3", hiveUrl: "http://127.0.0.1:1", hiveCli: "hive", brief: "Ship it.", argv: PANE_ARGV });
  codex.last().exit(1);
  await Bun.sleep(10);
  expect(rt.probe("t3")).toEqual({ alive: false, status: "gone" });
  expect(rt.goneByCwd("/tmp/wt3")).toBe(true);
  expect(rt.goneByCwd("/elsewhere")).toBeNull();
});

test("exec and resume argv drop --ask-for-approval, which codex exec rejects", () => {
  const pane = ["codex", "--ask-for-approval", "on-request", "--sandbox", "workspace-write", "brief"];
  expect(execArgv(pane)).toEqual(["codex", "exec", "--json", "--sandbox", "workspace-write", "brief"]);
  expect(resumeArgv(pane, "th-9", "steer")).toEqual(["codex", "exec", "resume", "th-9", "--json", "--sandbox", "workspace-write", "steer"]);
  expect(execArgv(["codex", "--ask-for-approval=never", "brief"])).toEqual(["codex", "exec", "--json", "brief"]);
});

test("argv splicing keeps every pane flag and item lines carry one cheap field", () => {
  expect(execArgv(["codex", "-c", "features.hooks=true", "brief"])).toEqual(["codex", "exec", "--json", "-c", "features.hooks=true", "brief"]);
  expect(resumeArgv(["codex", "-c", "features.hooks=true", "brief"], "th-9", "steer")).toEqual([
    "codex", "exec", "resume", "th-9", "--json", "-c", "features.hooks=true", "steer",
  ]);
  expect(itemLine({ item_type: "agent_message", text: "done" })).toBe("done");
  expect(itemLine({ id: "item_0", type: "agent_message", text: "PING" })).toBe("PING"); // live shape: `type`, not `item_type`
  expect(itemLine({ item_type: "file_change", file_path: "/a/b.ts" })).toBe("▸ file_change: /a/b.ts");
  expect(itemLine({ item_type: "reasoning", text: "thinking" })).toBe("thinking");
});
