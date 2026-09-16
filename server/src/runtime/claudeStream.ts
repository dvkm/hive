// Protocol driver for Claude Code: `claude -p --input-format stream-json
// --output-format stream-json`, one long-lived subprocess per task. No pane, no
// screen scraping, no keystrokes. The brief and every steer go in as JSON user
// messages on stdin; assistant text, tool calls and the end of each turn come
// out as JSON lines on stdout. Hooks still run inside `-p` (the worktree's
// .claude/settings.local.json), so hive's event pipeline is unchanged: this
// driver owns CONTROL (spawn, steer, status, wait, close), not the timeline.
//
// Status mirrors the pane runtime's vocabulary so everything above the runtime
// (supervision, reconciler, cleanup) reads it unchanged: `working` from the
// moment a message is sent until the `result` line closes the turn, `idle`
// after that, `gone` once the process exits. A finished session stays `idle`
// with its process alive, exactly like a claude that idles at its prompt.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../exec.ts";
import type { AgentStatus } from "./herdr.ts";

export interface StreamProc {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  write(line: string): void;
  end(): void;
  kill(): void;
}
export type SpawnProc = (argv: string[], opts: { cwd: string; env: Record<string, string> }) => StreamProc;

export interface StreamSpawnArgs {
  taskId: string;
  cwd: string;
  hiveUrl: string;
  hiveCli: string;
  brief: string;
  env?: Record<string, string>;
  model?: string;
  mcp?: "none" | "inherit";
}

interface Session {
  taskId: string;
  cwd: string;
  sessionId: string;
  proc: StreamProc;
  alive: boolean;
  exitCode: number | null;
  status: AgentStatus;
  lastEventAt: number;
  transcript: string[];
  idleWaiters: Set<() => void>;
}

const TRANSCRIPT_MAX = 600;
const SUMMARY_MAX = 140;

function bunSpawn(argv: string[], opts: { cwd: string; env: Record<string, string> }): StreamProc {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    pid: proc.pid,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    write: (line) => {
      proc.stdin.write(line);
      proc.stdin.flush();
    },
    end: () => proc.stdin.end(),
    kill: () => proc.kill(),
  };
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) yield buf;
}

// One line per tool call for the transcript: the tool and its cheapest field.
export function toolLine(name: string, input: any): string {
  const pick = input?.command ?? input?.file_path ?? input?.pattern ?? input?.description ?? input?.prompt ?? "";
  const s = String(pick).replace(/\s+/g, " ").trim();
  return `▸ ${name}${s ? `: ${s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX - 1) + "…" : s}` : ""}`;
}

// The stdin message that carries a brief or a steer.
export function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

export function streamArgv(sessionId: string, model?: string, mcp: "none" | "inherit" = "none"): string[] {
  const a = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "auto", "--session-id", sessionId];
  if (model) a.push("--model", model);
  // HIVE-641, same as the pane argv: no MCP servers unless the project opts in.
  if (mcp !== "inherit") a.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  return a;
}

export class ClaudeStreamRuntime {
  private sessions = new Map<string, Session>();

  constructor(
    private spawnProc: SpawnProc = bunSpawn,
    private logDir: string | null = join(homedir(), ".hive", "streams")
  ) {}

  has(target: string | null | undefined): boolean {
    return !!target && this.sessions.has(target);
  }

  sessionId(target: string): string | null {
    return this.sessions.get(target)?.sessionId ?? null;
  }

  // The worktree's session, if this runtime is the one driving it. null = not ours.
  goneByCwd(cwd: string | null | undefined): boolean | null {
    if (!cwd) return null;
    for (const s of this.sessions.values()) if (s.cwd === cwd) return !s.alive;
    return null;
  }

  list(): { name: string; tabId: string | null }[] {
    return [...this.sessions.values()].filter((s) => s.alive).map((s) => ({ name: s.taskId, tabId: null }));
  }

  async spawn(args: StreamSpawnArgs): Promise<{ sessionId: string; pid: number }> {
    // A respawn replaces the task's previous session; never leave two alive.
    this.close(args.taskId);
    const sessionId = crypto.randomUUID();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(args.env ?? {}),
      HIVE_TASK_ID: args.taskId,
      HIVE_URL: args.hiveUrl,
      HIVE_CLI: args.hiveCli,
    };
    const proc = this.spawnProc(streamArgv(sessionId, args.model, args.mcp), { cwd: args.cwd, env });
    const session: Session = {
      taskId: args.taskId,
      cwd: args.cwd,
      sessionId,
      proc,
      alive: true,
      exitCode: null,
      status: "working",
      lastEventAt: Date.now(),
      transcript: [],
      idleWaiters: new Set(),
    };
    this.sessions.set(args.taskId, session);
    void this.pump(session);
    proc.exited.then(
      (code) => this.markGone(session, code),
      () => this.markGone(session, -1)
    );
    proc.write(userMessage(args.brief));
    this.note(session, `› ${args.brief.split("\n")[0].slice(0, SUMMARY_MAX)}`);
    return { sessionId, pid: proc.pid };
  }

  send(target: string, message: string): ExecResult {
    const s = this.sessions.get(target);
    if (!s) return { code: 1, stdout: "", stderr: "no protocol session for this agent" };
    if (!s.alive) return { code: 1, stdout: "", stderr: "agent process has exited; respawn required" };
    try {
      s.proc.write(userMessage(message));
    } catch (e: any) {
      return { code: 1, stdout: "", stderr: `write failed: ${String(e?.message ?? e)}` };
    }
    s.status = "working";
    s.lastEventAt = Date.now();
    this.note(s, `› ${message.split("\n")[0].slice(0, SUMMARY_MAX)}`);
    return { code: 0, stdout: "", stderr: "" };
  }

  probe(target: string): { alive: boolean; status: AgentStatus } {
    const s = this.sessions.get(target);
    if (!s) return { alive: false, status: "unknown" };
    return { alive: s.alive, status: s.alive ? s.status : "gone" };
  }

  read(target: string, count = 200): string {
    const s = this.sessions.get(target);
    if (!s) return "(no protocol session)";
    return s.transcript.slice(-Math.max(1, count)).join("\n");
  }

  // Resolve with code 0 the moment the session reaches `status`; code 1 on
  // timeout or when the process is gone — the pane runtime's `wait` contract.
  wait(target: string, status: AgentStatus, timeoutMs: number): Promise<ExecResult> {
    const s = this.sessions.get(target);
    if (!s) return Promise.resolve({ code: 1, stdout: "", stderr: "no protocol session for this agent" });
    if (!s.alive) return Promise.resolve({ code: 1, stdout: "", stderr: "agent process has exited" });
    if (s.status === status || (status === "idle" && s.status === "done")) return Promise.resolve({ code: 0, stdout: JSON.stringify({ status: s.status }), stderr: "" });
    if (status !== "idle") return Promise.resolve({ code: 1, stdout: "", stderr: `wait for ${status} is not supported by the protocol driver` });
    return new Promise((resolve) => {
      const done = (r: ExecResult) => {
        clearTimeout(timer);
        s.idleWaiters.delete(wake);
        resolve(r);
      };
      const wake = () => done(s.alive ? { code: 0, stdout: JSON.stringify({ status: s.status }), stderr: "" } : { code: 1, stdout: "", stderr: "agent process has exited" });
      const timer = setTimeout(() => done({ code: 1, stdout: "", stderr: "wait timed out" }), timeoutMs);
      s.idleWaiters.add(wake);
    });
  }

  close(target: string): { closed: boolean; via: string | null } {
    const s = this.sessions.get(target);
    if (!s) return { closed: false, via: null };
    this.sessions.delete(target);
    if (!s.alive) return { closed: false, via: "protocol" };
    try {
      s.proc.end();
    } catch {
      /* stdin may already be closed */
    }
    try {
      s.proc.kill();
    } catch {
      /* already exited */
    }
    this.markGone(s, s.exitCode ?? -1);
    return { closed: true, via: "protocol" };
  }

  private markGone(s: Session, code: number): void {
    if (!s.alive) return;
    s.alive = false;
    s.exitCode = code;
    s.status = "gone";
    this.note(s, `(agent process exited with code ${code})`);
    for (const wake of s.idleWaiters) wake();
  }

  private note(s: Session, line: string): void {
    s.transcript.push(line);
    if (s.transcript.length > TRANSCRIPT_MAX) s.transcript.splice(0, s.transcript.length - TRANSCRIPT_MAX);
  }

  private log(s: Session, line: string): void {
    if (!this.logDir) return;
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(join(this.logDir, `${s.taskId}.jsonl`), line + "\n");
    } catch {
      /* the log is a debugging aid, never load-bearing */
    }
  }

  private async pump(s: Session): Promise<void> {
    try {
      for await (const line of lines(s.proc.stdout)) {
        if (!line.trim()) continue;
        this.log(s, line);
        this.onEvent(s, line);
      }
    } catch {
      /* stream closed; exit handling marks the session gone */
    }
  }

  private onEvent(s: Session, line: string): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    s.lastEventAt = Date.now();
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") s.sessionId = ev.session_id;
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block?.type === "text" && String(block.text ?? "").trim()) this.note(s, String(block.text).trim());
        else if (block?.type === "tool_use") this.note(s, toolLine(String(block.name ?? "tool"), block.input));
      }
    }
    if (ev.type === "result") {
      s.status = "idle";
      for (const wake of s.idleWaiters) wake();
    }
  }
}
