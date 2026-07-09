// hive CLI — thin HTTP wrappers around the daemon. The server is the only DB writer.
// Installed as bin/hive (bun shebang). Base URL: HIVE_URL or http://127.0.0.1:<HIVE_PORT|4700>.
import { readFileSync } from "node:fs";

const BASE =
  process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;

const USAGE = `hive — local orchestration control plane

Usage:
  hive serve                              start the daemon
  hive task create --project <id> --title <t> [--brief <file>] [--kind ship|scout|chore]
  hive task list [--state <s>] [--project <id>]
  hive emit <task-id> <type> [--note <s>] [--file <path>] [--kind <k>] [--source <s>]
        types: status | evidence | needs-decision | done | blocked | <custom>
  hive decision ask <task-id> --title <t> [--context <s>] [--risk <s>] [--blast <s>]
        --option key:label:detail  (repeatable)  --recommend <key>
  hive policy add --title <t> --body <s>|--body-file <f> [--scope global|project:<id>]
  hive policy list [--scope <s>]
  hive open                               open the board in a browser

Env: HIVE_URL, HIVE_PORT, HIVE_DB`;

// Parse "--flag value" pairs; repeated flags collect into an array. Bare tokens
// go into positional `_`.
function parseFlags(argv: string[]): { _: string[]; flags: Record<string, any> } {
  const _: string[] = [];
  const flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      if (key in flags) flags[key] = ([] as any[]).concat(flags[key], val);
      else flags[key] = val;
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => die(`cannot reach hive server at ${BASE} (${e.message}). Is 'hive serve' running?`));
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) die(`error ${res.status}: ${data.error || text}`);
  return data;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  if (cmd === "serve") {
    await import("../server/src/index.ts");
    return;
  }

  if (cmd === "task") {
    const sub = argv[1];
    const { flags } = parseFlags(argv.slice(2));
    if (sub === "create") {
      if (!flags.project) die("--project is required");
      if (!flags.title) die("--title is required");
      const brief = flags.brief ? readFileSync(String(flags.brief), "utf8") : undefined;
      const t = await api("POST", "/api/tasks", {
        project_id: flags.project,
        title: flags.title,
        brief,
        kind: flags.kind,
      });
      console.log(`created task ${t.id}  [${t.state}]  ${t.title}`);
      return;
    }
    if (sub === "list") {
      const qs = new URLSearchParams();
      if (flags.state) qs.set("state", String(flags.state));
      if (flags.project) qs.set("project_id", String(flags.project));
      const tasks = await api("GET", "/api/tasks?" + qs.toString());
      if (!tasks.length) return console.log("(no tasks)");
      for (const t of tasks)
        console.log(`${t.id}  ${t.state.padEnd(14)} ${t.kind.padEnd(6)} ${t.title}`);
      return;
    }
    die(`unknown 'task' subcommand: ${sub}\n\n${USAGE}`);
  }

  if (cmd === "emit") {
    const { _, flags } = parseFlags(argv.slice(1));
    const [taskId, type] = _;
    if (!taskId || !type) die("usage: hive emit <task-id> <type> [--note ...] [--file path]");
    const path = `/api/tasks/${taskId}/events`;
    let result: any;
    if (flags.file) {
      const form = new FormData();
      form.set("type", type);
      if (flags.kind) form.set("kind", String(flags.kind));
      if (flags.note) form.set("note", String(flags.note));
      if (flags.caption) form.set("caption", String(flags.caption));
      if (flags.source) form.set("source", String(flags.source));
      const file = Bun.file(String(flags.file));
      form.set("file", file);
      const res = await fetch(BASE + path, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) die(`error ${res.status}: ${data.error}`);
      result = data;
    } else {
      result = await api("POST", path, {
        type,
        note: flags.note,
        kind: flags.kind,
        source: flags.source,
        title: flags.title,
        context: flags.context,
      });
    }
    console.log(`emitted '${type}' on ${taskId}` + (result.evidence ? ` (evidence ${result.evidence.id})` : ""));
    return;
  }

  if (cmd === "decision") {
    const sub = argv[1];
    const { _, flags } = parseFlags(argv.slice(2));
    if (sub === "ask") {
      const taskId = _[0];
      if (!taskId) die("usage: hive decision ask <task-id> --title ... --option k:l:d ...");
      if (!flags.title) die("--title is required");
      const rawOpts = ([] as any[]).concat(flags.option || []);
      const recommend = flags.recommend ? String(flags.recommend) : undefined;
      const options = rawOpts.map((o: string) => {
        const [key, label, ...rest] = String(o).split(":");
        return { key, label: label ?? key, detail: rest.join(":") || "", recommended: key === recommend };
      });
      const d = await api("POST", "/api/decisions", {
        task_id: taskId,
        title: flags.title,
        context: flags.context,
        risk: flags.risk,
        blast_radius: flags.blast,
        options,
      });
      console.log(`opened decision ${d.id}: ${d.title}`);
      return;
    }
    die(`unknown 'decision' subcommand: ${sub}\n\n${USAGE}`);
  }

  if (cmd === "policy") {
    const sub = argv[1];
    const { flags } = parseFlags(argv.slice(2));
    if (sub === "add") {
      if (!flags.title) die("--title is required");
      const body = flags["body-file"] ? readFileSync(String(flags["body-file"]), "utf8") : flags.body;
      if (!body) die("--body or --body-file is required");
      const p = await api("POST", "/api/policies", {
        title: flags.title,
        body,
        scope: flags.scope,
      });
      console.log(`added policy ${p.id} [${p.scope}]: ${p.title}`);
      return;
    }
    if (sub === "list") {
      const qs = new URLSearchParams();
      if (flags.scope) qs.set("scope", String(flags.scope));
      const pols = await api("GET", "/api/policies?" + qs.toString());
      if (!pols.length) return console.log("(no policies)");
      for (const p of pols)
        console.log(`${p.id}  ${p.active ? "on " : "off"} [${p.scope}] ${p.title}`);
      return;
    }
    die(`unknown 'policy' subcommand: ${sub}\n\n${USAGE}`);
  }

  if (cmd === "open") {
    const url = BASE + "/";
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([opener, url]);
    console.log(`opening ${url}`);
    return;
  }

  die(`unknown command: ${cmd}\n\n${USAGE}`);
}

main();
