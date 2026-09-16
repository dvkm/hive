import { expect, test } from "bun:test";
import { ClaudeStreamRuntime, streamArgv, toolLine, userMessage } from "../src/runtime/claudeStream.ts";

// A stand-in for the claude subprocess: a controllable stdout, captured stdin, a
// resolvable exit. Lets the driver's status machine run without a model call.
function fakeProc() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const enc = new TextEncoder();
  const writes: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  return {
    proc: { pid: 4242, stdout, stderr: null, exited, write: (l: string) => { writes.push(l); }, end: () => {}, kill: () => resolveExit(137) },
    emit: (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")),
    writes,
    exit: (code: number) => { controller.close(); resolveExit(code); },
  };
}

test("the brief goes in as a user message, words and tool calls land in the transcript, result ends the turn, exit is gone", async () => {
  const fake = fakeProc();
  const rt = new ClaudeStreamRuntime(() => fake.proc, null);
  await rt.spawn({ taskId: "t1", cwd: "/tmp/wt", hiveUrl: "http://127.0.0.1:1", hiveCli: "hive", brief: "Fix the parser." });
  expect(fake.writes[0]).toBe(userMessage("Fix the parser."));
  expect(rt.probe("t1")).toEqual({ alive: true, status: "working" });
  expect(rt.list()).toEqual([{ name: "t1", tabId: null }]);

  fake.emit({ type: "system", subtype: "init", session_id: "sess-1" });
  fake.emit({ type: "assistant", message: { content: [{ type: "text", text: "Reading the parser first." }, { type: "tool_use", name: "Bash", input: { command: "bun test" } }] } });
  fake.emit({ type: "result", subtype: "success" });
  expect((await rt.wait("t1", "idle", 1000)).code).toBe(0);
  expect(rt.probe("t1").status).toBe("idle");
  expect(rt.sessionId("t1")).toBe("sess-1");
  const said = rt.read("t1", 10);
  expect(said).toContain("Reading the parser first.");
  expect(said).toContain("▸ Bash: bun test");

  expect(rt.send("t1", "Also fix the tests.").code).toBe(0);
  expect(fake.writes[1]).toBe(userMessage("Also fix the tests."));
  expect(rt.probe("t1").status).toBe("working");
  expect((await rt.wait("t1", "idle", 20)).code).toBe(1); // still working: times out like herdr's wait

  fake.exit(0);
  await Bun.sleep(10);
  expect(rt.probe("t1")).toEqual({ alive: false, status: "gone" });
  expect(rt.goneByCwd("/tmp/wt")).toBe(true);
  expect(rt.goneByCwd("/elsewhere")).toBeNull();
  expect(rt.send("t1", "x").code).toBe(1);
  expect(rt.close("t1").closed).toBe(false);
  expect(rt.has("t1")).toBe(false);
});

test("argv pins the protocol flags and tool lines carry one cheap field", () => {
  expect(streamArgv("abc", "opus")).toEqual([
    "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--session-id", "abc", "--model", "opus",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  ]);
  expect(streamArgv("abc", undefined, "inherit")).not.toContain("--strict-mcp-config");
  expect(toolLine("Edit", { file_path: "/a/b.ts" })).toBe("▸ Edit: /a/b.ts");
  expect(toolLine("Read", {})).toBe("▸ Read");
});
