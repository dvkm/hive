// hive CLI — thin HTTP wrappers around the daemon. The server is the only DB writer.
// Installed as bin/hive (bun shebang). Base URL: HIVE_URL or http://127.0.0.1:<HIVE_PORT|4700>.
import { existsSync, readFileSync } from "node:fs";
import { appBrowserCandidates, installedHiveAppCandidates, openUrlArgv, tailscaleCandidates } from "./platform.ts";

const BASE =
  process.env.HIVE_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`;

const USAGE = `hive — local orchestration control plane

Usage:
  hive serve                              start the daemon
  hive task create --project <id> --title <t> [--brief <file> | --brief-text <s>]
        [--kind ship|scout|chore] [--parent <task-id>] [--depends-on <id,id>] [--track]
        [--priority now|next|normal|later]
        (under a hive agent, HIVE_TASK_ID makes source=agent + parent automatic;
         --track = tracking-only: never auto-dispatched, moves freely, no evidence gate)
        (priority is queue ORDER, never preemption. Omit it and the task inherits
         its parent's, or starts at 'next' when the brief is security-shaped,
         else 'normal'. Tasks created together in a depends-on chain do NOT
         inherit from the chain head: pass --priority on each one you want it on.
         Only the director may set 'now' — under a hive agent it is refused.)
  hive task send <task-id> <message>   attributed teammate message under a hive agent
  hive task move <task-id> <state> [--note <s>]   states: queued in_progress needs_decision
        in_review verifying done failed cancelled
  hive task list [--state <s>] [--project <id>]
  hive task update <task-id> [--depends-on <id,id>] [--priority now|next|normal|later]
        --depends-on declares a dependency discovered mid-task
        (e.g. "my PR needs #993's to merge first"); full replace, so pass every
        id this task should still wait on, not just the new one
  hive emit <task-id> <type> [--note <s>] [--file <path>] [--json <file>] [--kind <k>] [--source <s>] [--pr-url <url>] [--landing-commit <sha>] [--verify-name <name>]
        types: status | evidence | needs-decision | ready | done | unmergeable | blocked | deferred | undefer | review_summary | <custom>
        unmergeable: this task's PR has nothing left to merge (GitHub refused to
        reopen it) but the work landed via a different PR/commit. Pass
        --landing-commit <sha>; hive verifies it's on the base branch, then closes
        the task without a merge step.
        --verify-name <name>: on evidence, tags the artifact with the named
        verification command it came from (see the brief's Verification contract)
        review_summary: --json review.json with {done[], iffy[], decisions[], testing[], followups[], understanding{check{question,options[],answer_key}}}
        deferred: park a task waiting on an OFFLINE human action (no more "gone quiet" nudges);
                  [--until <iso>] or [--days <n>] to auto-resume, else indefinite. undefer to resume early.
        ready: PR open (or scout report written) → hand off to review (in_progress -> in_review)
  hive decision ask <task-id> --title <t> --context <s> [--risk <s>] [--blast <s>]
        --option key:label:detail  (repeatable)  --recommend <key>  --needs-input <key>
  hive decision auto-answer <decision-id> --key <option> [--reason <s>] [--actor <session>]
        supervisor self-approval: answers ONLY if the server-enforced safety bar
        clears, else exits 3 and leaves the card open for the director
  hive policy add --title <t> --body <s>|--body-file <f> [--scope global|project:<id>]
  hive policy list [--scope <s>]
  hive authority add --action <pattern> --effect allow|require_decision|deny [--project <id>] [--note <s>]
  hive authority list [--project <id>]
  hive authority rm <rule-id>
  hive learning add --project <id> --title <t> --kind failure|reference
        [--body <s>] [--task <src-task-id>] [--root-cause]  (root-cause: failure only, auto-spawns a chore task)
  hive learning list [--project <id>] [--status active|resolved]
  hive learning recur <learning-id>
  hive playbook create <task-id>          distil a done task into a reusable playbook (a reference)
  hive playbook list [--project <id>]
  hive land <task-id...> [--off]          mark in-review tasks approved-to-land; hive merges
        them in graph order (declared dependencies first, one conflicting branch per sweep)
  hive land-graph [--project <id>]        show the review column's ordering edges
  hive recall <keywords>                  search project knowledge (references, learnings, policies)
  hive garden [--project <id>] [--apply] [--remote] [--json]
        prune task branches + worktrees using task state, not git reachability.
        Deletes a branch only when its task is done; keeps cancelled/failed
        branches; never touches a branch with no task, a ghost-* WIP rescue, a
        branch hive does not own, or one checked out somewhere. Dry run unless
        --apply.
  hive jira link <task-id> --parent <KEY> create and link a Jira sub-task
  hive spawn <task-id>                    spawn a herdr agent for a task
  hive chat send [--project <id>|--thread <id>] "<text>"   message the persistent chat supervisor
  hive chat reply <thread-id> "<text>" [--decision <id> ...]
                                              post one reply with actionable decision cards
  hive chat update <thread-id> [--phase <phase>] [--objective <text>] [--criterion <text> ...]
        [--next <text>] [--waiting <text>] [--wakeup <iso>] [--outcome <text>]
  hive chat commit <thread-id> --project <id> --title <text>
        (--source-message <id> | --source-task <id>) [--owner <task-id>]
        [--depends-on <commitment-id,...>] [--due <iso>]
  hive chat commit-update <thread-id> <commitment-id> [--status open|in_progress|blocked|done|dropped]
        [--title <text>] [--owner <task-id>] [--depends-on <commitment-id,...>] [--due <iso>]
  hive chat meeting <thread-id> --stage proposal|critique|decided [--meeting <id>]
        [--topic <text>] [--participants <task-id,...>] [--summary <text>] [--recommendation <text>]
        [--dissent <text> ...] [--evidence <text> ...] [--risk <text> ...]
  hive chat verify <thread-id> --status started|passed|failed --method <text>
        [--result <text>] [--tasks <task-id,...>] [--evidence <evidence-id,...>] [--replay-of <id>]
  hive chat retrospect <thread-id> --summary <text> [--worked <text> ...]
        [--problem <text> ...] [--lesson <text> ...]
  hive chat close <thread-id>             end a thread's live session (reclaims its worktree/agent)
  hive steer-all "message" [--project <id>] [--actor <session>]   broadcast a steer to every live agent
  hive tunnel                             expose hive to your phone over Tailscale HTTPS (private; enables push)
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
  hive notify --test                      fire one real desktop notification and report whether
        the desktop app rendered it (proves the whole chain without a real event)
  hive open                               open the board in a browser
  hive app                                open the hive desktop app (native notifications
        + badge; install once: cd electron && bun install && bun run install-app)

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

// The commit HEAD was at when evidence was captured, so the review card can
// flag it stale against the PR's current head (task #226). Best-effort: cwd
// may not be a git repo (or git may be missing) — evidence still gets filed.
function gitHeadSha(): string | null {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

// Config/secret writes need the API token even over loopback (see
// requireWriteAuth in server/src/api.ts). Being on this machine as this user IS
// the capability: we read the token the server minted out of its own DB, the
// same way `hive remote` prints it. Sent on every call — harmless elsewhere.
let cachedToken: string | null | undefined;
async function localToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const { Database } = await import("bun:sqlite");
    const { defaultDbPath } = await import("../server/src/db.ts");
    const row = new Database(defaultDbPath(), { readonly: true })
      .query("SELECT value FROM settings WHERE key = 'api_token'")
      .get() as { value: string } | null;
    cachedToken = row?.value ?? null;
  } catch {
    cachedToken = null; // no local DB (remote HIVE_URL) — the server will say so
  }
  return cachedToken;
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const token = await localToken();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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
    const { _, flags } = parseFlags(argv.slice(2));
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
        depends_on: flags["depends-on"] ? String(flags["depends-on"]) : undefined,
        source: flags.track ? "external" : agentTask ? "agent" : undefined,
        priority: flags.priority ? String(flags.priority) : undefined,
      });
      console.log(`created task ${t.id}  [${t.state}]  ${t.title}`);
      // #989: the server checks the brief's file paths against the chosen
      // project's repo. A mismatch is loud here because this is where it is
      // cheap to fix — the alternative is an agent in the wrong worktree.
      if (t.warning) console.log(`  ⚠ ${t.warning}`);
      return;
    }
    if (sub === "send") {
      const taskId = _[0];
      const text = _.slice(1).join(" ").trim() || (flags.text ? String(flags.text) : "");
      if (!taskId || !text) die('usage: hive task send <task-id> "<message>"');
      const r = await api("POST", `/api/tasks/${taskId}/send`, {
        message: text,
        from_task_id: process.env.HIVE_TASK_ID || undefined,
      });
      console.log(`message to ${taskId}: ${r.delivery}`);
      return;
    }
    if (sub === "move") {
      const [taskId, to] = _;
      if (!taskId || !to) die("usage: hive task move <task-id> <state> [--note <s>]");
      const t = await api("POST", `/api/tasks/${taskId}/transition`, { to, reason: flags.note });
      console.log(`task ${t.id} -> [${t.state}]  ${t.title}`);
      if (t.bounce?.respawned) console.log(`  respawned the agent with your note in its brief`);
      else if (t.bounce && !t.bounce.delivered)
        console.log(`  note recorded but no agent is running — run: hive spawn ${t.id}`);
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
    if (sub === "update") {
      const taskId = _[0];
      if (!taskId) die("usage: hive task update <task-id> [--depends-on <id,id>] [--priority now|next|normal|later]");
      if (flags["depends-on"] === undefined && flags.priority === undefined)
        die("pass --depends-on (full replace — every id this task should wait on) and/or --priority");
      const t = await api("PUT", `/api/tasks/${taskId}`, {
        depends_on: flags["depends-on"] !== undefined ? String(flags["depends-on"]) : undefined,
        priority: flags.priority ? String(flags.priority) : undefined,
      });
      console.log(`task ${t.id} depends_on: ${t.depends_on.length ? t.depends_on.join(", ") : "(none)"}  priority: ${t.priority}`);
      return;
    }
    die(`unknown 'task' subcommand: ${sub}\n\n${USAGE}`);
  }

  if (cmd === "land") {
    const { _, flags } = parseFlags(argv.slice(1));
    if (!_.length) die("usage: hive land <task-id...> [--off]");
    const res = await api("POST", "/api/tasks/land-queue", { task_ids: _, queued: !flags.off });
    console.log(`${res.changed.length} task(s) ${res.queued ? "queued to land" : "removed from the land queue"}`);
    return;
  }

  if (cmd === "land-graph") {
    const { flags } = parseFlags(argv.slice(1));
    const qs = flags.project ? `?project=${encodeURIComponent(String(flags.project))}` : "";
    const g = await api("GET", `/api/tasks/land-graph${qs}`);
    const name = (id: string) => {
      const n = g.nodes.find((x: any) => x.id === id);
      return n ? `#${n.number} ${n.title}` : id;
    };
    if (!g.edges.length) return console.log("(no ordering edges — every open PR can land on its own)");
    for (const e of g.edges)
      console.log(`${name(e.to)}  ${e.kind === "depends" ? "lands after" : "conflicts with"}  ${name(e.from)}${e.files ? ` (${e.files.join(", ")})` : ""}`);
    return;
  }

  if (cmd === "emit") {
    const { _, flags } = parseFlags(argv.slice(1));
    const [taskId, type] = _;
    if (!taskId || !type) die("usage: hive emit <task-id> <type> [--note ...] [--file path]");
    const path = `/api/tasks/${taskId}/events`;
    const sha = type === "evidence" ? gitHeadSha() : null;
    let result: any;
    if (flags.file) {
      const form = new FormData();
      form.set("type", type);
      if (flags.kind) form.set("kind", String(flags.kind));
      if (flags.note) form.set("note", String(flags.note));
      if (flags.caption) form.set("caption", String(flags.caption));
      if (flags.source) form.set("source", String(flags.source));
      if (flags["verify-name"]) form.set("verify_name", String(flags["verify-name"]));
      if (sha) form.set("meta", JSON.stringify({ commit_sha: sha }));
      const file = Bun.file(String(flags.file));
      form.set("file", file);
      const res = await fetch(BASE + path, { method: "POST", body: form });
      const data: any = await res.json();
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
        until: flags.until,
        days: flags.days,
        pr_url: flags["pr-url"] ?? flags.url,
        landing_commit: flags["landing-commit"],
        verify_name: flags["verify-name"],
        ...(sha && !extra.meta ? { meta: JSON.stringify({ commit_sha: sha }) } : {}),
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
      if (typeof flags.context !== "string" || !flags.context.trim()) die("--context is required: explain why this needs a decision, what changes, and why you recommend one option");
      const rawOpts = ([] as any[]).concat(flags.option || []);
      const recommend = flags.recommend ? String(flags.recommend) : undefined;
      const needsInput = new Set(([] as any[]).concat(flags["needs-input"] || []).map(String));
      const options = rawOpts.map((o: string) => {
        const [key, label, ...rest] = String(o).split(":");
        return {
          key,
          label: label ?? key,
          detail: rest.join(":") || "",
          recommended: key === recommend,
          ...(needsInput.has(key) ? { requires_input: true } : {}),
        };
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
    if (sub === "auto-answer") {
      const id = _[0];
      if (!id) die('usage: hive decision auto-answer <decision-id> --key <option> [--reason "..."] [--actor <session>]');
      if (!flags.key) die("--key is required");
      // Not api(): a 403 here means "not auto-approvable, escalate to the
      // director" — an expected outcome, not a CLI error to die on.
      const r = await fetch(BASE + `/api/decisions/${id}/auto-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answer_key: String(flags.key),
          answer_note: flags.reason ? String(flags.reason) : undefined,
          actor: flags.actor ? String(flags.actor) : undefined,
        }),
      }).catch((e) => die(`cannot reach hive server at ${BASE} (${e.message}). Is 'hive serve' running?`));
      const res: any = await r.json();
      if (r.status === 403 && res.effect === "escalate") {
        console.log(`escalated ${id} to the director: ${res.reason}`);
        process.exitCode = 3; // distinct exit code — "not auto-approvable"
        return;
      }
      if (!r.ok) die(`error ${r.status}: ${res.error || JSON.stringify(res)}`);
      console.log(`auto-approved ${id} (${res.answer_key})`);
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
      if (flags.kind !== "failure" && flags.kind !== "reference")
        die("--kind is required: failure|reference (no silent default — pick one)");
      if (flags["root-cause"] && flags.kind !== "failure")
        die("--root-cause only applies to --kind failure (it auto-spawns a root-cause chore task)");
      const l = await api("POST", "/api/learnings", {
        project_id: flags.project,
        title: flags.title,
        body: flags.body,
        kind: flags.kind, // "failure" | "reference" — required, validated above, no default
        source_task_id: flags.task,
        create_root_cause_task: !!flags["root-cause"],
      });
      const label = flags.kind === "reference" ? "reference" : "learning";
      console.log(`added ${label} ${l.id}: ${l.title}` + (l.root_cause_task_id ? `  (root-cause task ${l.root_cause_task_id})` : ""));
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

  // Playbooks are kind='reference' learnings whose body starts with
  // `[playbook]`, so they need no store of their own — just a create call and a
  // filtered list.
  if (cmd === "playbook") {
    const sub = argv[1];
    const { _, flags } = parseFlags(argv.slice(2));
    if (sub === "create") {
      const taskId = _[0];
      if (!taskId) die("usage: hive playbook create <task-id>");
      const r = await api("POST", `/api/tasks/${taskId}/playbook`, {});
      console.log(`playbook ${r.learning_id}: ${r.playbook.title}`);
      console.log(`  when to use: ${r.playbook.when_to_use}`);
      for (const s of r.playbook.steps) console.log(`  - ${s}`);
      return;
    }
    if (sub === "list") {
      const qs = new URLSearchParams({ status: "active" });
      if (flags.project) qs.set("project_id", String(flags.project));
      const rows = await api("GET", "/api/learnings?" + qs.toString());
      const books = rows.filter((l: any) => l.kind === "reference" && String(l.body ?? "").startsWith("[playbook]"));
      if (!books.length) return console.log("(no playbooks)");
      for (const l of books) console.log(`${l.id}  ${l.title}\n    ${String(l.body).split("\n")[0].slice(11)}`);
      return;
    }
    die(`unknown 'playbook' subcommand: ${sub}\n\n${USAGE}`);
  }

  if (cmd === "spawn") {
    const { _ } = parseFlags(argv.slice(1));
    const taskId = _[0];
    if (!taskId) die("usage: hive spawn <task-id>");
    const r = await api("POST", `/api/tasks/${taskId}/spawn`, {});
    console.log(`spawned agent ${r.agent_target} for task ${taskId}`);
    return;
  }

  if (cmd === "chat") {
    const sub = argv[1];
    const { _, flags } = parseFlags(argv.slice(2));
    // `hive chat reply <thread-id> <text>` — the supervisor session replies to
    // the director (the ONLY director-facing channel from a chat agent).
    if (sub === "reply") {
      const threadId = _[0];
      const text = _.slice(1).join(" ").trim() || (flags.text ? String(flags.text) : "");
      if (!threadId || !text) die('usage: hive chat reply <thread-id> "<text>"');
      const decisionIds = flags.decision == null ? [] : ([] as any[]).concat(flags.decision).map(String);
      const r = await api("POST", `/api/chat/threads/${threadId}/reply`, { text, decision_ids: decisionIds });
      console.log(r.suppressed ? `suppressed routine reply on ${threadId}` : `replied on ${threadId}`);
      return;
    }
    // `hive chat send [--project <id>] [--thread <id>] <text>` — the director
    // sends a message to the supervisor session (starts one if needed).
    if (sub === "send") {
      const text = _.join(" ").trim() || (flags.text ? String(flags.text) : "");
      if (!text) die('usage: hive chat send [--project <id> | --thread <id>] "<text>"');
      const r = await api("POST", `/api/chat/turn`, {
        text,
        ...(flags.thread ? { thread_id: String(flags.thread) } : {}),
        ...(flags.project ? { project_id: String(flags.project) } : {}),
      });
      console.log(`thread ${r.thread_id}: ${r.delivery}${r.error ? ` (${r.error})` : ""}`);
      return;
    }
    if (sub === "update") {
      const threadId = _[0];
      if (!threadId) die("usage: hive chat update <thread-id> [--phase ...]");
      const criteria = flags.criterion == null ? undefined : ([] as any[]).concat(flags.criterion).map(String);
      const r = await api("PUT", `/api/chat/threads/${threadId}/run`, {
        phase: flags.phase,
        objective: flags.objective,
        acceptance_criteria: criteria,
        next_action: flags.next,
        waiting_on: flags.waiting,
        wakeup_at: flags.wakeup,
        outcome: flags.outcome,
      });
      console.log(`run ${threadId}: ${r.phase}${r.next_action ? ` → ${r.next_action}` : ""}`);
      return;
    }
    if (sub === "meeting") {
      const threadId = _[0];
      if (!threadId || !flags.stage) die("usage: hive chat meeting <thread-id> --stage proposal|critique|decided ...");
      const participants = flags.participants ? String(flags.participants).split(",").filter(Boolean) : undefined;
      const r = await api("POST", `/api/chat/threads/${threadId}/meetings`, {
        meeting_id: flags.meeting,
        stage: flags.stage,
        topic: flags.topic,
        participants,
        summary: flags.summary,
        decision: flags.decision,
        recommendation: flags.recommendation,
        dissent: flags.dissent == null ? undefined : ([] as any[]).concat(flags.dissent).map(String),
        evidence: flags.evidence == null ? undefined : ([] as any[]).concat(flags.evidence).map(String),
        risks: flags.risk == null ? undefined : ([] as any[]).concat(flags.risk).map(String),
      });
      console.log(`meeting ${r.meeting_id}: ${r.stage} (${r.delivered}/${r.participants.length} notified)`);
      return;
    }
    if (sub === "commit") {
      const threadId = _[0];
      if (!threadId || !flags.title) die("usage: hive chat commit <thread-id> --project <id> --title <text> (--source-message <id> | --source-task <id>) ...");
      const r = await api("POST", `/api/chat/threads/${threadId}/commitments`, {
        project_id: flags.project,
        title: flags.title,
        owner_task_id: flags.owner,
        source_message_id: flags["source-message"],
        source_task_id: flags["source-task"],
        depends_on: flags["depends-on"] ? String(flags["depends-on"]).split(",").filter(Boolean) : undefined,
        due_at: flags.due,
      });
      console.log(`commitment ${r.id}: ${r.status}  ${r.title}`);
      return;
    }
    if (sub === "commit-update") {
      const [threadId, commitmentId] = _;
      if (!threadId || !commitmentId) die("usage: hive chat commit-update <thread-id> <commitment-id> [--status ...]");
      const r = await api("PUT", `/api/chat/threads/${threadId}/commitments/${commitmentId}`, {
        title: flags.title,
        status: flags.status,
        owner_task_id: flags.owner,
        depends_on: flags["depends-on"] ? String(flags["depends-on"]).split(",").filter(Boolean) : undefined,
        due_at: flags.due,
      });
      console.log(`commitment ${r.id}: ${r.status}  ${r.title}`);
      return;
    }
    if (sub === "verify") {
      const threadId = _[0];
      if (!threadId || !flags.status || !flags.method) die("usage: hive chat verify <thread-id> --status started|passed|failed --method <text> ...");
      const r = await api("POST", `/api/chat/threads/${threadId}/verifications`, {
        status: flags.status,
        method: flags.method,
        result: flags.result,
        target_task_ids: flags.tasks ? String(flags.tasks).split(",").filter(Boolean) : undefined,
        evidence_ids: flags.evidence ? String(flags.evidence).split(",").filter(Boolean) : undefined,
        replay_of: flags["replay-of"],
      });
      console.log(`verification ${r.verification_id}: ${r.status}`);
      return;
    }
    if (sub === "retrospect") {
      const threadId = _[0];
      if (!threadId || !flags.summary) die("usage: hive chat retrospect <thread-id> --summary <text> ...");
      const many = (value: any) => value == null ? [] : ([] as any[]).concat(value).map(String);
      const r = await api("POST", `/api/chat/threads/${threadId}/retrospectives`, {
        summary: flags.summary,
        worked: many(flags.worked),
        problems: many(flags.problem),
        lessons: many(flags.lesson),
      });
      console.log(`retrospective ${r.retrospective_id} recorded`);
      return;
    }
    // `hive chat close <thread-id>` — end the thread's live session so its
    // worktree/agent gets reclaimed (immediately, then the reaper backstop).
    if (sub === "close") {
      const threadId = _[0];
      if (!threadId) die("usage: hive chat close <thread-id>");
      await api("POST", `/api/chat/threads/${threadId}/close`, {});
      console.log(`closed ${threadId}`);
      return;
    }
    die("usage: hive chat reply <thread-id> <text>  |  hive chat send [--project <id>|--thread <id>] <text>  |  hive chat close <thread-id>");
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

  if (cmd === "jira") {
    const sub = argv[1];
    const { _, flags } = parseFlags(argv.slice(2));
    if (sub !== "link" || !_[0] || !flags.parent) die("usage: hive jira link <task-id> --parent <KEY>");
    const linked = await api("POST", `/api/tasks/${_[0]}/jira/link`, { parent_key: String(flags.parent) });
    console.log(`linked ${_[0]} to ${linked.jira_key} (${linked.browse_url})`);
    for (const warning of linked.warnings ?? []) console.warn(`warning: ${warning}`);
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
      // The provider owns the ref (`hive/<project>/<name>`); the server derives
      // the same one, so nothing client-side gets to choose it.
      await providerFor(provider).set(project, name, value);
      await api("POST", `/api/projects/${project}/secrets`, { name, provider });
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
    const { flags } = parseFlags(argv.slice(1));
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
    // Sidecar: background type/lint checks on an agent's fresh commits, and how
    // often they caught something. Per-day, so it compares across --days values.
    const sidecar = one(
      `SELECT COUNT(*) n, SUM(json_extract(payload,'$.ok') = 0) caught
         FROM events WHERE type='sidecar_report' AND ts > ?`, since);
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
    console.log(`  sidecar:        ${sidecar.n} checks, ${sidecar.caught ?? 0} caught problems (${(sidecar.n / days).toFixed(1)}/day)`);
    console.log(`  CI gate:        ${held} handoffs held, ${bounced} bounced out of review`);
    console.log(`  review->merge:  avg ${review.h ?? "-"}h`);
    for (const c of cost) console.log(`  cost:           ${c.model}  $${c.c}  (${c.t} tasks)`);
    console.log(`\nfewer steers/nudges per shipped task = more autonomy. Compare week over week.`);
    return;
  }

  // Expose hive over Tailscale HTTPS (private mesh, real cert → iOS push works).
  // Needs `tailscale up` done once (that's the user's account login).
  if (cmd === "tunnel") {
    const port = process.env.HIVE_PORT || 4700;
    const run = (args: string[]) => {
      for (const bin of tailscaleCandidates()) {
        try {
          const r = Bun.spawnSync([bin, ...args]);
          if (r.exitCode !== 127) return { ...r, bin };
        } catch {
          /* binary not at this path; try next */
        }
      }
      return null;
    };
    const setup =
      "Tailscale isn't set up yet. One-time steps (yours — it's your account):\n" +
      `  1. Install Tailscale on this ${process.platform === "win32" ? "Windows PC" : process.platform === "darwin" ? "Mac" : "Linux machine"} and log in.\n` +
      "  2. Install Tailscale on your iPhone and log into the SAME account.\n" +
      "  3. Re-run `hive tunnel`.";
    const status = run(["status"]);
    if (!status) die(setup);
    if (status.exitCode !== 0) die(status.stderr.toString().includes("Logged out") || status.exitCode === 1 ? setup : status.stderr.toString());
    const ts = status.bin;
    // `tailscale serve` fronts hive with a Tailscale-managed HTTPS cert on your
    // <machine>.<tailnet>.ts.net name. Backgrounded so it persists.
    const serve = Bun.spawnSync([ts, "serve", "--bg", String(port)]);
    if (serve.exitCode !== 0) {
      console.error(serve.stderr.toString());
      die("`tailscale serve` failed (older Tailscale? try `tailscale serve https / http://127.0.0.1:" + port + "`)");
    }
    const dns = Bun.spawnSync([ts, "status", "--json"]);
    let host = "<machine>.<tailnet>.ts.net";
    try {
      host = JSON.parse(dns.stdout.toString()).Self?.DNSName?.replace(/\.$/, "") || host;
    } catch {}
    const { Database } = await import("bun:sqlite");
    const { defaultDbPath } = await import("../server/src/db.ts");
    const tok = (new Database(defaultDbPath(), { readonly: true }).query("SELECT value FROM settings WHERE key='api_token'").get() as any)?.value;
    console.log(`hive is now reachable from your phone (Tailscale, private + encrypted):\n\n  https://${host}/\n`);
    console.log(`API token (paste once in the app): ${tok ?? "(start the server once to mint it)"}\n`);
    console.log("On the iPhone: open that URL in Safari → Share → Add to Home Screen → open the app → tap 🔔 notify.");
    console.log("Stop exposing: `tailscale serve --bg=false " + port + "` or `tailscale serve reset`.");
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

  // Recall project knowledge (references, learnings, policies) on demand.
  //   hive recall <keywords>            (project from $HIVE_TASK_ID, or --project)
  if (cmd === "recall") {
    const { _, flags } = parseFlags(argv.slice(1));
    const q = _.join(" ");
    const qs = new URLSearchParams();
    if (flags.project) qs.set("project_id", String(flags.project));
    else if (process.env.HIVE_TASK_ID) qs.set("task_id", process.env.HIVE_TASK_ID);
    else die("run under a hive task (HIVE_TASK_ID) or pass --project <id>");
    if (q) qs.set("q", q);
    const r = await api("GET", "/api/knowledge?" + qs.toString());
    const show = (label: string, items: any[]) => {
      if (!items.length) return;
      console.log(`\n## ${label}`);
      for (const it of items) console.log(`- ${it.title}${it.body ? `\n  ${String(it.body).replace(/\n/g, "\n  ")}` : ""}`);
    };
    if (!r.references.length && !r.learnings.length && !r.policies.length && !(r.decisions?.length)) {
      console.log(q ? `no project knowledge matches "${q}"` : "no project knowledge stored yet");
      return;
    }
    show("References (durable facts)", r.references);
    show("Decisions already made (don't re-ask)", r.decisions ?? []);
    show("Known failure patterns", r.learnings);
    show("Policies", r.policies);
    return;
  }

  // Watchers: poll a doc/page and queue an act-on-change task.
  //   hive watch add --project <id> --name <n> --url <u> [--prompt <s>] [--kind chore] [--interval <min>]
  //   hive watch list [--project <id>]
  //   hive watch rm --project <id> --name <n>
  if (cmd === "watch") {
    const sub = argv[1];
    const { flags } = parseFlags(argv.slice(2));
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
  //   hive steer-all "message" [--project <id>] [--actor <session>]
  if (cmd === "steer-all") {
    const message = argv[1];
    const { flags } = parseFlags(argv.slice(2));
    if (!message) die('usage: hive steer-all "message" [--project <id>] [--actor <session>]');
    const r = await api("POST", "/api/steer/broadcast", {
      message,
      ...(flags.project ? { project_id: String(flags.project) } : {}),
      ...(flags.actor ? { actor: String(flags.actor) } : {}),
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

  // Fire one real notification through the live delivery path and wait for the
  // desktop app to confirm macOS rendered it. Only the app can confirm, so a
  // timeout means the notification did not actually appear.
  if (cmd === "notify") {
    const { flags } = parseFlags(argv.slice(1));
    if (!flags.test) die("usage: hive notify --test");
    const { id, app_clients } = await api("POST", "/api/notifications/test");
    if (!app_clients)
      console.log("desktop app is NOT connected — falling back to launching it via hive://");
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { notifications, last_delivery_error } = await api("GET", "/api/notifications");
      const row = notifications.find((n: any) => n.id === id);
      if (row?.delivered_at) {
        console.log(`OK — hive.app rendered the notification at ${row.delivered_at} (${id})`);
        return;
      }
      if (last_delivery_error?.id === id)
        die(
          `The OS refused the notification: ${last_delivery_error.error}\n` +
            "Turn hive's notifications on in system notification settings, then run this again."
        );
    }
    die(
      `no confirmation after 10s (${id}). The notification did not render. Check that hive.app is running (hive app) ` +
        "and that hive is allowed to notify in System Settings > Notifications."
    );
  }

  // Garden the checkout: prune task branches and worktrees using TASK STATE
  // (see server/src/branchGardener.ts). Read-only against the DB; dry run
  // unless --apply, and origin is only touched with --remote on top of it.
  if (cmd === "garden") {
    const { flags } = parseFlags(argv.slice(1));
    const { Database } = await import("bun:sqlite");
    const { defaultDbPath } = await import("../server/src/db.ts");
    const { gardenRepos, formatGardenReport } = await import("../server/src/branchGardener.ts");
    const db = new Database(defaultDbPath(), { readonly: true }) as any;
    const reports = await gardenRepos(db, {
      apply: !!flags.apply,
      remote: !!flags.remote,
      projectId: flags.project as string | undefined,
    });
    if (flags.json) {
      console.log(JSON.stringify(reports, null, 2));
      return;
    }
    for (const r of reports) console.log(formatGardenReport(r) + "\n");
    if (!flags.apply) console.log("dry run — nothing was deleted. Re-run with --apply (add --remote to also delete on origin).");
    return;
  }

  if (cmd === "open") {
    const url = BASE + "/";
    Bun.spawn(openUrlArgv(url), { stdout: "ignore", stderr: "ignore" });
    console.log(`opening ${url}`);
    return;
  }

  // The hive desktop app (Electron: native notifications + dock badge). Always
  // the installed bundle, never a checkout copy: launching a bundle re-registers
  // it with LaunchServices, so opening a worktree build would steal `dev.hive.app`
  // and the hive:// deeplinks back from the canonical install.
  // Falls back to a chromeless Chrome window, then the default browser.
  if (cmd === "app") {
    const url = BASE + "/";
    const appPath = installedHiveAppCandidates().find(existsSync);
    if (appPath) {
      const argv = process.platform === "darwin" ? ["open", appPath] : [appPath];
      Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
      console.log(`opening hive desktop app (${appPath})`);
      return;
    }
    const browser = appBrowserCandidates().find(
      (candidate) => (!candidate.includes("/") && !candidate.includes("\\")) || existsSync(candidate)
    );
    if (browser) {
      try {
        Bun.spawn([browser, `--app=${url}`], { stdout: "ignore", stderr: "ignore" });
        console.log(`hive desktop app not installed (cd electron && bun install && bun run install-app) — app window on ${url}`);
        return;
      } catch {
        // Fall through to the default browser.
      }
    }
    Bun.spawn(openUrlArgv(url), { stdout: "ignore", stderr: "ignore" });
    console.log(`opened ${url} in the default browser`);
    return;
  }

  die(`unknown command: ${cmd}\n\n${USAGE}`);
}

main();
