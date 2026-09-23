// Protocol driver for Codex: `codex exec --json`, one subprocess per TURN. No
// pane, no screen scraping, no keystrokes. Unlike claude's stream-json mode,
// `codex exec` reads stdin once as extra prompt — it is not a live message
// channel — so a steer is a fresh `codex exec resume <thread_id> --json <text>`
// against the same thread. The session object outlives the processes: it holds
// the thread id, the transcript and the steer queue, and hive above the runtime
// keeps addressing one task id.
//
// Status uses the same vocabulary as the pane and claude runtimes: `working`
// from turn.started until turn.completed/turn.failed, `idle` in between turns
// (the thread is resumable, exactly like a claude idling at its prompt), `gone`
// once close() is called or a process dies without ever giving us a thread id.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../exec.ts";
import { lines, toolLine, type SpawnProc, type StreamProc } from "./claudeStream.ts";
import type { AgentStatus } from "./herdr.ts";

export interface CodexSpawnArgs {
  taskId: string;
  cwd: string;
  hiveUrl: string;
  hiveCli: string;
  brief: string;
  // The full pane argv from api.ts `codexAgentArgv` (flags + trailing brief).
  // Absent only in tests / a project with no codex config at all.
  argv?: string[];
  env?: Record<string, string>;
}

interface Session {
  taskId: string;
  cwd: string;
  threadId: string | null;
  argv: string[];
  env: Record<string, string>;
  proc: StreamProc | null;
  pid: number;
  alive: boolean;
  status: AgentStatus;
  lastEventAt: number;
  queue: string[];
  transcript: string[];
  idleWaiters: Set<() => void>;
}

const TRANSCRIPT_MAX = 600;
const SUMMARY_MAX = 140;

function bunSpawn(argv: string[], opts: { cwd: string; env: Record<string, string> }): StreamProc {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    pid: proc.pid,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
    write: () => {},
    end: () => {},
    kill: () => proc.kill(),
  };
}

// The pane argv is `codex <flags…> <brief>`; the exec form is the same command
// with the subcommand spliced in, so hooks, sandbox and model stay identical.
// `codex exec` rejects the pane-only --ask-for-approval flag, so it is dropped.
function paneOnlyStripped(flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--ask-for-approval") i++;
    else if (!flags[i].startsWith("--ask-for-approval=")) out.push(flags[i]);
  }
  return out;
}

export function execArgv(argv: string[]): string[] {
  return [argv[0], "exec", "--json", ...paneOnlyStripped(argv.slice(1, -1)), ...argv.slice(-1)];
}

// A steer is a new turn on the same thread: same flags, brief swapped for the
// steer text. `thread_id` first and the prompt last keeps the two positionals
// in the order `codex exec resume` expects.
export function resumeArgv(argv: string[], threadId: string, text: string): string[] {
  return [argv[0], "exec", "resume", threadId, "--json", ...paneOnlyStripped(argv.slice(1, -1)), text];
}

// One transcript line per `item.completed`. Codex's own text comes through as
// agent_message/reasoning; everything else is a tool call, formatted like the
// claude driver's.
export function itemLine(item: any): string {
  const kind = String(item?.item_type ?? item?.type ?? "item");
  if (kind === "agent_message" || kind === "reasoning") return String(item?.text ?? "").trim();
  return toolLine(kind, item);
}

export class CodexStreamRuntime {
  private sessions = new Map<string, Session>();

  constructor(
    private spawnProc: SpawnProc = bunSpawn,
    private logDir: string | null = join(homedir(), ".hive", "streams")
  ) {}

  has(target: string | null | undefined): boolean {
    return !!target && this.sessions.has(target);
  }

  // The codex thread id, so a human can `codex exec resume <id>` by hand.
  sessionId(target: string): string | null {
    return this.sessions.get(target)?.threadId ?? null;
  }

  goneByCwd(cwd: string | null | undefined): boolean | null {
    if (!cwd) return null;
    for (const s of this.sessions.values()) if (s.cwd === cwd) return !s.alive;
    return null;
  }

  list(): { name: string; tabId: string | null }[] {
    return [...this.sessions.values()].filter((s) => s.alive).map((s) => ({ name: s.taskId, tabId: null }));
  }

  async spawn(args: CodexSpawnArgs): Promise<{ sessionId: string; pid: number }> {
    // A respawn replaces the task's previous session; never leave two alive.
    this.close(args.taskId);
    const argv = args.argv?.length ? args.argv : ["codex", args.brief];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(args.env ?? {}),
      HIVE_TASK_ID: args.taskId,
      HIVE_URL: args.hiveUrl,
      HIVE_CLI: args.hiveCli,
    };
    const session: Session = {
      taskId: args.taskId,
      cwd: args.cwd,
      threadId: null,
      argv,
      env,
      proc: null,
      pid: 0,
      alive: true,
      status: "working",
      lastEventAt: Date.now(),
      queue: [],
      transcript: [],
      idleWaiters: new Set(),
    };
    this.sessions.set(args.taskId, session);
    this.note(session, `› ${args.brief.split("\n")[0].slice(0, SUMMARY_MAX)}`);
    this.startTurn(session, execArgv(argv));
    return { sessionId: session.threadId ?? "", pid: session.pid };
  }

  send(target: string, message: string): ExecResult {
    const s = this.sessions.get(target);
    if (!s) return { code: 1, stdout: "", stderr: "no protocol session for this agent" };
    if (!s.alive) return { code: 1, stdout: "", stderr: "agent process has exited; respawn required" };
    s.status = "working";
    s.lastEventAt = Date.now();
    this.note(s, `› ${message.split("\n")[0].slice(0, SUMMARY_MAX)}`);
    // One live turn per thread: anything sent mid-turn waits for the process to
    // exit, then starts the next turn itself (see finishTurn).
    s.queue.push(message);
    if (!s.proc) this.flush(s);
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
    const proc = s.proc;
    this.markGone(s, "closed");
    if (!proc) return { closed: true, via: "protocol" };
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
    return { closed: true, via: "protocol" };
  }

  private startTurn(s: Session, argv: string[]): void {
    const proc = this.spawnProc(argv, { cwd: s.cwd, env: s.env });
    s.proc = proc;
    s.pid = proc.pid;
    s.status = "working";
    s.lastEventAt = Date.now();
    void this.pump(s, proc);
    proc.exited.then(
      (code) => this.finishTurn(s, proc, code),
      () => this.finishTurn(s, proc, -1)
    );
  }

  // A turn's process exited. The session survives it: the thread is resumable,
  // so we go idle and start whatever was queued while it ran.
  private finishTurn(s: Session, proc: StreamProc, code: number): void {
    if (s.proc !== proc) return; // superseded by close()/respawn
    s.proc = null;
    if (!s.alive) return;
    if (code !== 0 && !s.threadId) {
      // Nothing to resume: codex never got far enough to name a thread.
      this.markGone(s, `first turn exited with code ${code} before a thread id`);
      return;
    }
    if (code !== 0) this.note(s, `(codex turn exited with code ${code})`);
    this.goIdle(s);
    this.flush(s);
  }

  private flush(s: Session): void {
    if (!s.alive || s.proc || !s.queue.length) return;
    if (!s.threadId) {
      this.note(s, "(steer dropped: codex never reported a thread id)");
      s.queue.length = 0;
      return;
    }
    this.startTurn(s, resumeArgv(s.argv, s.threadId, s.queue.shift()!));
  }

  private goIdle(s: Session): void {
    s.status = "idle";
    for (const wake of s.idleWaiters) wake();
  }

  private markGone(s: Session, why: string): void {
    if (!s.alive) return;
    s.alive = false;
    s.status = "gone";
    this.note(s, `(codex session gone: ${why})`);
    for (const wake of s.idleWaiters) wake();
  }

  private note(s: Session, line: string): void {
    if (!line) return;
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

  private async pump(s: Session, proc: StreamProc): Promise<void> {
    try {
      for await (const line of lines(proc.stdout)) {
        if (!line.trim()) continue;
        this.log(s, line);
        this.onEvent(s, line);
      }
    } catch {
      /* stream closed; the exit handler decides idle vs gone */
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
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") s.threadId = ev.thread_id;
    else if (ev.type === "turn.started") s.status = "working";
    else if (ev.type === "item.completed") this.note(s, itemLine(ev.item));
    else if (ev.type === "turn.completed") this.goIdle(s);
    else if (ev.type === "turn.failed") {
      // A failed turn is not a dead agent: the thread is still resumable, and
      // the error is what a human or the supervisor needs to read.
      this.note(s, `(codex turn failed: ${String(ev.error?.message ?? ev.error?.type ?? "unknown error")})`);
      this.goIdle(s);
    }
  }
}
