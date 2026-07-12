// hive CLI — thin HTTP wrappers around the daemon. The server is the only DB writer.
// Installed as bin/hive (bun shebang). Base URL: HIVE_URL or http://127.0.0.1:<HIVE_PORT|4700>.
import { readFileSync } from "node:fs";

const BASE =
  process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;

const USAGE = `hive — local orchestration control plane

Usage:
  hive serve                              start the daemon
  hive task create --project <id> --title <t> [--brief <file> | --brief-text <s>]
        [--kind ship|scout|chore] [--parent <task-id>] [--track]
        (under a hive agent, HIVE_TASK_ID makes source=agent + parent automatic;
         --track = tracking-only: never auto-dispatched, moves freely, no evidence gate)
  hive task move <task-id> <state> [--note <s>]   states: queued in_progress needs_decision
        in_review verifying done failed cancelled
  hive task list [--state <s>] [--project <id>]
  hive emit <task-id> <type> [--note <s>] [--file <path>] [--json <file>] [--kind <k>] [--source <s>] [--pr-url <url>]
        types: status | evidence | needs-decision | ready | done | blocked | review_summary | <custom>
        review_summary: --json review.json with {done[], iffy[], decisions[], testing[], followups[]}
        ready: PR open (or scout report written) → hand off to review (in_progress -> in_review)
  hive decision ask <task-id> --title <t> [--context <s>] [--risk <s>] [--blast <s>]
        --option key:label:detail  (repeatable)  --recommend <key>
  hive policy add --title <t> --body <s>|--body-file <f> [--scope global|project:<id>]
  hive policy list [--scope <s>]
  hive authority add --action <pattern> --effect allow|require_decision|deny [--project <id>] [--note <s>]
  hive authority list [--project <id>]
  hive authority rm <rule-id>
  hive learning add --project <id> --title <t> [--body <s>] [--task <src-task-id>] [--root-cause]
  hive learning list [--project <id>] [--status active|resolved]
  hive learning recur <learning-id>
  hive spawn <task-id>                    spawn a herdr agent for a task
  hive steer-all "message" [--project <id>]   broadcast a steer to every live agent
  hive remote                             print LAN URL + API token for phone access (PWA)
  hive stats [--days 7]                   autonomy scorecard (steers, decisions, CI gate, cost)
  hive watch add --project <id> --name <n> --url <u> [--prompt <s>] [--kind <k>] [--interval <min>]
  hive watch list [--project <id>]        poll a doc/page; changes queue an act-on-change task
  hive watch rm --project <id> --name <n>   (Google Docs edit links auto-use the txt export; doc must be link-readable)
  hive pr-marker <task-id>                print the PR title prefix + body footer marker for a task
  hive gchat auth [--client-id <id>] [--client-secret <s>] [--self users/<id>] [--port <p>]
        one-time Google Chat OAuth consent; stores the refresh token in the keychain
        (client id/secret also read from GCHAT_CLIENT_ID / GCHAT_CLIENT_SECRET env)
  hive secret set --project <id> --name <n> [--provider keychain|bitwarden]
        (reads the value from stdin; writes to the provider, stores only a ref)
  hive secret list --project <id>
  hive secret rm --project <id> --name <n>
  hive offline [on|off]                   drain the fleet before losing internet / resume after
  hive open                               open the board in a browser
  hive app                                open the hive desktop app (native notifications
        + dock badge; build once: cd electron && bun install && bun run build)

Env: HIVE_URL, HIVE_PORT, HIVE_DB, BW_SESSION`;

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
      const brief = flags.brief
        ? readFileSync(String(flags.brief), "utf8")
        : flags["brief-text"]
          ? String(flags["brief-text"])
          : undefined;
      // Running under a spawned agent (HIVE_TASK_ID set): attribute the task to
      // the agent and default the parent to the spawning task. --track marks a
      // tracking-only task (source='external'): never auto-dispatched, moves
      // freely through states — hive as a kanban for OTHER agents' own work.
      const agentTask = process.env.HIVE_TASK_ID;
      const t = await api("POST", "/api/tasks", {
        project_id: flags.project,
        title: flags.title,
        brief,
        kind: flags.kind,
        parent_task_id: flags.parent ?? agentTask ?? undefined,
        source: flags.track ? "external" : agentTask ? "agent" : undefined,
      });
      console.log(`created task ${t.id}  [${t.state}]  ${t.title}`);
      return;
    }
    if (sub === "move") {
      const { _ } = parseFlags(argv.slice(2));
      const [taskId, to] = _;
      if (!taskId || !to) die("usage: hive task move <task-id> <state> [--note <s>]");
      const t = await api("POST", `/api/tasks/${taskId}/transition`, { to, reason: flags.note });
      console.log(`task ${t.id} -> [${t.state}]  ${t.title}`);
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
      // --json <file> merges a JSON object into the event payload — used for
      // structured events like review_summary (see the agent brief).
      const extra = flags.json ? JSON.parse(readFileSync(String(flags.json), "utf8")) : {};
      result = await api("POST", path, {
        type,
        note: flags.note,
        kind: flags.kind,
        source: flags.source,
        title: flags.title,
        context: flags.context,
        pr_url: flags["pr-url"] ?? flags.url,
        ...extra,
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

  if (cmd === "authority") {
    const sub = argv[1];
    const { _, flags } = parseFlags(argv.slice(2));
    if (sub === "add") {
      if (!flags.action) die("--action is required");
      if (!flags.effect) die("--effect is required (allow | require_decision | deny)");
      const r = await api("POST", "/api/authority/rules", {
        project_id: flags.project,
        action_pattern: flags.action,
        effect: flags.effect,
        note: flags.note,
      });
      console.log(`added authority rule ${r.id} [${r.scope}] ${r.action_pattern} -> ${r.effect}`);
      return;
    }
    if (sub === "list") {
      const qs = new URLSearchParams();
      if (flags.project) qs.set("project_id", String(flags.project));
      const rules = await api("GET", "/api/authority/rules?" + qs.toString());
      if (!rules.length) return console.log("(no authority rules)");
      for (const r of rules)
        console.log(`${r.id}  ${r.active ? "on " : "off"} [${r.scope}] ${r.action_pattern.padEnd(18)} -> ${r.effect}`);
      return;
    }
    if (sub === "rm") {
      const id = _[0];
      if (!id) die("usage: hive authority rm <rule-id>");
      await api("DELETE", `/api/authority/rules/${id}`);
      console.log(`removed authority rule ${id}`);
      return;
    }
    die(`unknown 'authority' subcommand: ${sub}\n\n${USAGE}`);
  }

  if (cmd === "learning") {
    const sub = argv[1];
    const { _, flags } = parseFlags(argv.slice(2));
    if (sub === "add") {
      if (!flags.project) die("--project is required");
      if (!flags.title) die("--title is required");
      const l = await api("POST", "/api/learnings", {
        project_id: flags.project,
        title: flags.title,
        body: flags.body,
        source_task_id: flags.task,
        create_root_cause_task: !!flags["root-cause"],
      });
      console.log(`added learning ${l.id}: ${l.title}` + (l.root_cause_task_id ? `  (root-cause task ${l.root_cause_task_id})` : ""));
      return;
    }
    if (sub === "list") {
      const qs = new URLSearchParams();
      if (flags.project) qs.set("project_id", String(flags.project));
      if (flags.status) qs.set("status", String(flags.status));
      const learnings = await api("GET", "/api/learnings?" + qs.toString());
      if (!learnings.length) return console.log("(no learnings)");
      for (const l of learnings)
        console.log(`${l.id}  ${l.status.padEnd(8)} ${String(l.occurrences).padStart(3)}×  ${l.title}`);
      return;
    }
    if (sub === "recur") {
      const id = _[0];
      if (!id) die("usage: hive learning recur <learning-id>");
      const l = await api("POST", `/api/learnings/${id}/recur`, {});
      console.log(`learning ${l.id} now at ${l.occurrences} occurrences`);
      return;
    }
    die(`unknown 'learning' subcommand: ${sub}\n\n${USAGE}`);
  }

  if (cmd === "spawn") {
    const { _ } = parseFlags(argv.slice(1));
    const taskId = _[0];
    if (!taskId) die("usage: hive spawn <task-id>");
    const r = await api("POST", `/api/tasks/${taskId}/spawn`, {});
    console.log(`spawned agent ${r.agent_target} for task ${taskId}`);
    return;
  }

  if (cmd === "pr-marker") {
    const { _ } = parseFlags(argv.slice(1));
    const taskId = _[0];
    if (!taskId) die("usage: hive pr-marker <task-id>");
    const t = await api("GET", `/api/tasks/${taskId}`);
    const { prTitlePrefix, prBodyFooter } = await import("../server/src/marker.ts");
    // The prefix already ends with a space; the agent prepends it to the PR title.
    console.log(`title-prefix: ${prTitlePrefix(t.number)}`);
    console.log(`body-footer:  ${prBodyFooter(t.id)}`);
    return;
  }

  if (cmd === "secret") {
    const sub = argv[1];
    const { flags } = parseFlags(argv.slice(2));
    const project = flags.project ? String(flags.project) : "";
    if (sub === "set") {
      if (!project) die("--project is required");
      if (!flags.name) die("--name is required");
      const name = String(flags.name);
      const provider = flags.provider ? String(flags.provider) : "keychain";
      // Read the value from stdin so it never lands in argv / shell history.
      const value = (await Bun.stdin.text()).replace(/\n$/, "");
      if (!value) die("no value on stdin (pipe or type the secret, then Ctrl-D)");
      const { providerFor } = await import("../server/src/secrets.ts");
      const { ref } = await providerFor(provider).set(project, name, value);
      const s = await api("POST", `/api/projects/${project}/secrets`, { name, provider, ref });
      console.log(`stored secret '${name}' [${provider}] for project ${project} (ref kept in provider only)`);
      return;
    }
    if (sub === "list") {
      if (!project) die("--project is required");
      const { secrets } = await api("GET", `/api/projects/${project}/secrets`);
      if (!secrets.length) return console.log("(no secrets)");
      for (const s of secrets) console.log(`${s.name.padEnd(20)} ${s.provider}`);
      return;
    }
    if (sub === "rm") {
      if (!project) die("--project is required");
      if (!flags.name) die("--name is required");
      const name = String(flags.name);
      // Best-effort provider delete, then remove the metadata row.
      const provider = flags.provider ? String(flags.provider) : "keychain";
      const { providerFor, serviceName } = await import("../server/src/secrets.ts");
      await providerFor(provider).rm(project, name, serviceName(project, name)).catch(() => {});
      await api("DELETE", `/api/projects/${project}/secrets/${encodeURIComponent(name)}`);
      console.log(`removed secret '${name}' for project ${project}`);
      return;
    }
    die(`unknown 'secret' subcommand: ${sub}\n\n${USAGE}`);
  }

  if (cmd === "gchat") {
    const sub = argv[1];
    const { flags } = parseFlags(argv.slice(2));
    if (sub === "auth") {
      const clientId = String(flags["client-id"] || process.env.GCHAT_CLIENT_ID || "");
      const clientSecret = String(flags["client-secret"] || process.env.GCHAT_CLIENT_SECRET || "");
      if (!clientId || !clientSecret)
        die("need --client-id and --client-secret (or GCHAT_CLIENT_ID / GCHAT_CLIENT_SECRET env)");
      const port = Number(flags.port || 4788);
      const redirectUri = `http://127.0.0.1:${port}`;
      const { buildAuthUrl, exchangeCode, GCHAT_NS } = await import("../server/src/intake/gchat.ts");
      const { providerFor } = await import("../server/src/secrets.ts");

      // Capture the OAuth redirect on a throwaway localhost server.
      const code: string = await new Promise((resolve, reject) => {
        const srv = Bun.serve({
          hostname: "127.0.0.1",
          port,
          fetch(req) {
            const c = new URL(req.url).searchParams.get("code");
            if (c) {
              setTimeout(() => srv.stop(), 100);
              resolve(c);
              return new Response("hive: Google Chat authorized. You can close this tab.", {
                headers: { "Content-Type": "text/plain" },
              });
            }
            return new Response("waiting for ?code=", { status: 400 });
          },
        });
        console.log(`\nOpen this URL in your browser, grant access, and return here:\n\n${buildAuthUrl(clientId, redirectUri)}\n`);
        setTimeout(() => { srv.stop(); reject(new Error("timed out waiting for consent")); }, 5 * 60 * 1000);
      });

      const tokens = await exchangeCode(clientId, clientSecret, code, redirectUri);
      if (!tokens.refresh_token)
        die("no refresh_token returned (revoke prior consent at myaccount.google.com and retry — needs prompt=consent)");

      const kc = providerFor("keychain");
      await kc.set(GCHAT_NS, "GCHAT_CLIENT_ID", clientId);
      await kc.set(GCHAT_NS, "GCHAT_CLIENT_SECRET", clientSecret);
      await kc.set(GCHAT_NS, "GCHAT_REFRESH_TOKEN", tokens.refresh_token);
      if (flags.self) await kc.set(GCHAT_NS, "GCHAT_SELF_ID", String(flags.self));
      console.log("stored Google Chat credentials in the keychain (hive/gchat/*). Add spaces to a project's config.gchat_spaces to start polling.");
      return;
    }
    die(`unknown 'gchat' subcommand: ${sub}\n\n${USAGE}`);
  }

  // Autonomy scorecard: is the fleet getting MORE autonomous or less? One
  // number per pain axis, computed straight from the DB (read-only).
  if (cmd === "stats") {
    const { Database } = await import("bun:sqlite");
    const { defaultDbPath } = await import("../server/src/db.ts");
    const db = new Database(defaultDbPath(), { readonly: true });
    const days = Number(flags.days ?? 7);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const one = (sql: string, ...a: unknown[]) => (db.query(sql).get(...(a as any)) as any) ?? {};

    const spawns = one("SELECT COUNT(*) n FROM events WHERE type='spawned' AND ts > ?", since).n;
    const spawnErr = one("SELECT COUNT(*) n FROM events WHERE type='spawn_error' AND ts > ?", since).n;
    const steers = one("SELECT COUNT(*) n FROM events WHERE type='steer' AND ts > ?", since).n;
    const nudges = one("SELECT COUNT(*) n FROM events WHERE type='recovery_nudge' AND ts > ?", since).n;
    const done = one("SELECT COUNT(*) n FROM tasks WHERE state='done' AND updated_at > ?", since).n;
    const dec = one(
      `SELECT COUNT(*) n, SUM(status='expired') expired,
              ROUND(AVG(CASE WHEN answered_at IS NOT NULL THEN (julianday(answered_at)-julianday(ts))*24*60 END),0) med_min
         FROM decisions WHERE ts > ?`, since);
    const held = one("SELECT COUNT(*) n FROM events WHERE type='ready_held' AND ts > ?", since).n;
    const bounced = one("SELECT COUNT(*) n FROM events WHERE type IN ('ci_failure','pr_closed') AND ts > ?", since).n;
    const cost = db.query(
      "SELECT model, ROUND(SUM(cost_usd),2) c, COUNT(DISTINCT task_id) t FROM usage WHERE ts > ? GROUP BY model ORDER BY c DESC"
    ).all(since) as any[];
    const review = one(
      `SELECT ROUND(AVG((julianday(m.ts)-julianday(r.ts))*24),1) h FROM
         (SELECT task_id, MIN(ts) ts FROM events WHERE type='ready_for_review' AND ts > ? GROUP BY task_id) r
         JOIN (SELECT task_id, MIN(ts) ts FROM events WHERE type='merged' GROUP BY task_id) m USING(task_id)`, since);

    console.log(`hive stats — last ${days}d`);
    console.log(`  shipped:        ${done} tasks done`);
    console.log(`  spawns:         ${spawns} ok, ${spawnErr} errors${spawns ? ` (${Math.round((100 * spawnErr) / (spawns + spawnErr))}% failure)` : ""}`);
    console.log(`  intervention:   ${steers} steers, ${nudges} gone-quiet nudges`);
    console.log(`  decisions:      ${dec.n} opened, ${dec.expired ?? 0} expired, avg answer ${dec.med_min ?? "-"}m`);
    console.log(`  CI gate:        ${held} handoffs held, ${bounced} bounced out of review`);
    console.log(`  review->merge:  avg ${review.h ?? "-"}h`);
    for (const c of cost) console.log(`  cost:           ${c.model}  $${c.c}  (${c.t} tasks)`);
    console.log(`\nfewer steers/nudges per shipped task = more autonomy. Compare week over week.`);
    return;
  }

  // Phone/tablet access: print the LAN URL + API token for the PWA.
  if (cmd === "remote") {
    const { Database } = await import("bun:sqlite");
    const { defaultDbPath } = await import("../server/src/db.ts");
    const db = new Database(defaultDbPath(), { readonly: true });
    const row = db.query("SELECT value FROM settings WHERE key = 'api_token'").get() as { value: string } | null;
    if (!row) die("no API token yet — start the server once (it mints one on boot)");
    const { networkInterfaces } = await import("node:os");
    const ips = Object.values(networkInterfaces()).flat()
      .filter((i: any) => i && i.family === "IPv4" && !i.internal)
      .map((i: any) => i.address);
    const port = process.env.HIVE_PORT || 4700;
    console.log(`API token: ${row.value}\n`);
    if (!ips.length) console.log("no LAN address found — is Wi-Fi/Ethernet up?");
    for (const ip of ips) console.log(`  http://${ip}:${port}/`);
    console.log(
      `\nOn the phone: open the URL in Safari, paste the token when prompted, then Share -> Add to Home Screen.` +
        `\nServer must be bound to the LAN: HIVE_BIND=0.0.0.0 (add to the LaunchAgent env, then restart).` +
        `\nPlain HTTP — use only on a trusted LAN or a Tailscale address.`
    );
    return;
  }

  // Watchers: poll a doc/page and queue an act-on-change task.
  //   hive watch add --project <id> --name <n> --url <u> [--prompt <s>] [--kind chore] [--interval <min>]
  //   hive watch list [--project <id>]
  //   hive watch rm --project <id> --name <n>
  if (cmd === "watch") {
    const sub = argv[1];
    const pid = flags.project ? String(flags.project) : null;
    if (sub === "list") {
      const projects = await api("GET", "/api/projects");
      for (const p of projects) {
        if (pid && p.id !== pid) continue;
        for (const w of p.config?.watchers ?? [])
          console.log(`${p.name}  ${w.name}  every ${w.interval_minutes ?? 5}m  ${w.url}${w.prompt ? `  — ${w.prompt}` : ""}`);
      }
      return;
    }
    if (!pid) die("--project is required");
    const project = await api("GET", `/api/projects/${pid}`);
    const watchers: any[] = project.config?.watchers ?? [];
    if (sub === "add") {
      if (!flags.name || !flags.url) die("usage: hive watch add --project <id> --name <n> --url <u> [--prompt <s>] [--kind <k>] [--interval <min>]");
      if (watchers.some((w) => w.name === flags.name)) die(`watcher '${flags.name}' already exists on ${project.name}`);
      watchers.push({
        name: String(flags.name),
        url: String(flags.url),
        ...(flags.prompt ? { prompt: String(flags.prompt) } : {}),
        ...(flags.kind ? { kind: String(flags.kind) } : {}),
        ...(flags.interval ? { interval_minutes: Number(flags.interval) } : {}),
      });
      await api("PUT", `/api/projects/${pid}`, { config: { ...project.config, watchers } });
      console.log(`watching '${flags.name}' on ${project.name} (first poll is a baseline; changes queue a ${flags.kind ?? "chore"} task)`);
      return;
    }
    if (sub === "rm") {
      if (!flags.name) die("usage: hive watch rm --project <id> --name <n>");
      const next = watchers.filter((w) => w.name !== flags.name);
      if (next.length === watchers.length) die(`no watcher '${flags.name}' on ${project.name}`);
      await api("PUT", `/api/projects/${pid}`, { config: { ...project.config, watchers: next } });
      console.log(`removed watcher '${flags.name}'`);
      return;
    }
    die(`unknown 'watch' subcommand: ${sub}\n\n${USAGE}`);
  }

  // Broadcast a steer to every live agent (optionally one project's):
  //   hive steer-all "message" [--project <id>]
  if (cmd === "steer-all") {
    const message = argv[1];
    if (!message) die('usage: hive steer-all "message" [--project <id>]');
    const r = await api("POST", "/api/steer/broadcast", {
      message,
      ...(flags.project ? { project_id: String(flags.project) } : {}),
    });
    console.log(`steered ${r.delivered}/${r.targets} live agents (undelivered are queued for respawn)`);
    return;
  }

  // Offline mode: drain the fleet before losing internet; resume when back.
  if (cmd === "offline") {
    const sub = argv[1];
    if (sub === "on" || sub === "off") {
      const r = await api("POST", "/api/offline", { on: sub === "on" });
      console.log(`offline mode ${r.on ? "ON — fleet draining" : "OFF — fleet resuming"} (${r.steered} agents steered)`);
    } else {
      const r = await api("GET", "/api/offline");
      console.log(`offline mode: ${r.on ? "ON" : "off"}`);
    }
    return;
  }

  if (cmd === "open") {
    const url = BASE + "/";
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([opener, url]);
    console.log(`opening ${url}`);
    return;
  }

  // The hive desktop app (Electron: native notifications + dock badge), built
  // at electron/dist by `bun run build` in electron/. Falls back to a
  // chromeless Chrome window, then the default browser.
  if (cmd === "app") {
    const url = BASE + "/";
    const { existsSync } = await import("node:fs");
    const appPath = new URL("../electron/dist/mac-arm64/hive.app", import.meta.url).pathname;
    if (existsSync(appPath)) {
      Bun.spawn(["open", appPath], { stdout: "ignore", stderr: "ignore" });
      console.log(`opening hive.app (${appPath})`);
      return;
    }
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    try {
      Bun.spawn([chrome, `--app=${url}`], { stdout: "ignore", stderr: "ignore" });
      console.log(`hive.app not built (cd electron && bun install && bun run build) — Chrome app window on ${url}`);
    } catch {
      Bun.spawn(["open", url]);
      console.log(`opened ${url} in the default browser`);
    }
    return;
  }

  die(`unknown command: ${cmd}\n\n${USAGE}`);
}

main();
