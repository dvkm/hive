// JIRA <-> hive bidirectional sync (Atlassian Jira Cloud).
//
// Mirrors issues from one Jira project onto the hive board and keeps `status`
// in step in BOTH directions. Hard no-op until a project opts in, same as the
// gchat intake connector.
//
// Config lives on the project row (`projects.config.jira`) and must pass the
// compiled-in credential and project allowlist below before any secret resolves.
// `enabled` is the master switch; `write` is a separate SHADOW-MODE gate — with
// enabled:true / write:false the sync imports and computes every outbound call
// but LOGS it instead of sending, so the director can read one cycle of "would
// have done X" before hive ever edits a real issue.
//
// Auth is HTTP Basic (`email:api_token`), NOT bearer: a personal Atlassian API
// token sent as `Authorization: Bearer` is rejected with a Connect-JWT parse
// error, because that path is reserved for Connect app JWTs. The token is the
// project secret JIRA_API_TOKEN (keychain, never in the DB).
//
// DESIGN NOTES (the non-obvious parts):
//
// * No new tables. `tasks.source_ref` already has a UNIQUE index and holds
//   `jira:<KEY>`, which IS the task<->issue link; `intake_cursors(source,key)`
//   already persists a poll position. A `jira_links` table would add surface for
//   the same guarantee.
//
// * Converging reconciler, not webhooks. hive binds loopback and has no public
//   ingress, so Jira Cloud cannot reach it; polling is the only transport that
//   works without exposing the box. That turns out to be the better design
//   anyway: each cycle writes ONLY when the two sides actually differ, so once a
//   write lands both sides agree and the next cycle finds nothing to do. Loop
//   prevention is therefore structural rather than a marker every code path has
//   to remember to check.
//
// * The conflict rule reads the CHANGELOG, never `fields.updated`. `updated`
//   moves on any edit at all (a comment, a label), so using it as the status
//   timestamp lets an unrelated edit win a status tiebreak.
//
// * Imported issues are tracking-only (`source='external'`): the dispatcher
//   skips them, so mirroring a human backlog never auto-spawns agents on it,
//   and the done-gate evidence requirement is skipped, since a ticket a human
//   closed in Jira will never have a hive PR attached.
import type { DB } from "../db.ts";
import { newId, now } from "../db.ts";
import { broadcast } from "../bus.ts";
import { writeEvent, getTask, transition, TERMINAL, type State } from "../state.ts";
import { broadcastTask } from "../health.ts";
import { resolveProjectSecrets } from "../secrets.ts";
import type { Exec } from "../exec.ts";
import { defaultExec } from "../exec.ts";

export type FetchLike = typeof fetch;

export const SOURCE = "jira"; // intake_cursors.source
export const REF_PREFIX = "jira:"; // tasks.source_ref = jira:WEB-7
export const NEEDS_DECISION_LABEL = "hive:needs-decision";
const MAX_PAGES = 20; // paging backstop; 100 issues/page
const MAX_COMMENT_PAGES = 20;
const HIVE_COMMENT_PROPERTY = "hive.event_id";

// Compiled-in allowlist. `projects.config` is attacker-writable (the loopback
// API is unauthenticated by design), so jiraConfig must not trust a caller's
// site/email — it validates against these BEFORE JIRA_API_TOKEN is ever
// resolved or an Authorization header is built.
const ALLOWED_HOST = "example.atlassian.net";
export const ALLOWED_SITE = `https://${ALLOWED_HOST}`;
export const ALLOWED_EMAIL = "jira@example.com";
const ALLOWED_PROJECT_KEYS = ["WEB"]; // array so adding one later is a one-line PR

export interface JiraConfig {
  site: string;
  email: string;
  project_key: string;
  enabled: boolean;
  write: boolean; // false = shadow mode (compute + log, never send)
  jql?: string; // extra filter, ANDed with project = <key>
}

export interface JiraDeps {
  fetch?: FetchLike;
  exec?: Exec; // keychain resolution
  log?: (msg: string, err?: unknown) => void;
  intervalMs?: number;
  token?: string; // bypass keychain (tests)
}

// ------------------------------------------------------------------- mapping
// The WEB workflow (To Do -> In Progress -> In Review -> Done) is Jira's
// untouched team-managed default and is shared by every issue type there.
export const JIRA_TO_STATE: Record<string, State> = {
  "to do": "queued",
  "in progress": "in_progress",
  "in review": "in_review",
  done: "done",
};

// hive -> Jira. Deliberately partial:
//  * needs_decision has NO Jira status; it rides as a label on top of whatever
//    status the issue already has (that is why it maps to null, not to a state).
//  * verifying means "merged, smoke checks pending" — still not Done to a human
//    reading the board, so it shows as In Review.
//  * failed/cancelled are hive lifecycle outcomes with no Jira equivalent;
//    pushing them would misreport the ticket, so they never move Jira.
export const STATE_TO_JIRA: Partial<Record<State, string>> = {
  queued: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  verifying: "In Review",
  done: "Done",
};

export function jiraStatusToState(name: string | undefined | null): State | null {
  return JIRA_TO_STATE[String(name ?? "").trim().toLowerCase()] ?? null;
}

export function stateToJiraStatus(state: string): string | null {
  return STATE_TO_JIRA[state as State] ?? null;
}

// Flatten Atlassian Document Format to plain text. ADF is a nested doc tree;
// every leaf that carries `text` is content, and paragraph-ish nodes break the
// line. Good enough to render a brief — hive never writes descriptions back.
export function adfToText(node: any): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  let out = "";
  if (typeof node.text === "string") out += node.text;
  if (Array.isArray(node.content)) out += node.content.map(adfToText).join("");
  if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem") out += "\n";
  if (node.type === "hardBreak") out += "\n";
  return out;
}

export function textToAdf(text: string): any {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}

// ---------------------------------------------------------------- timestamps
// When the issue's STATUS last changed, per the changelog — NOT `fields.updated`,
// which also moves for comments/labels/edits and would let an unrelated edit win
// a status tiebreak. An issue whose status never changed falls back to its
// creation time (it has been sitting in its initial status since then).
export function lastStatusChangeAt(issue: any): number {
  let best = 0;
  for (const h of issue?.changelog?.histories ?? []) {
    if (!(h.items ?? []).some((i: any) => i.field === "status" || i.fieldId === "status")) continue;
    const t = Date.parse(h.created ?? "");
    if (Number.isFinite(t) && t > best) best = t;
  }
  if (best) return best;
  const created = Date.parse(issue?.fields?.created ?? "");
  return Number.isFinite(created) ? created : 0;
}

// When the hive task's state last changed, from its own event log. Falls back
// to created_at for a task that has never transitioned.
export function lastStateChangeAt(db: DB, taskId: string): number {
  const r = db
    .query("SELECT ts FROM events WHERE task_id = ? AND type = 'state_change' ORDER BY ts DESC LIMIT 1")
    .get(taskId) as { ts: string } | undefined;
  if (r) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t)) return t;
  }
  const c = db.query("SELECT created_at FROM tasks WHERE id = ?").get(taskId) as { created_at: string } | undefined;
  const t = Date.parse(c?.created_at ?? "");
  return Number.isFinite(t) ? t : 0;
}

// ------------------------------------------------------------- conflict rule
export type SyncAction = "none" | "push" | "pull";

// The whole bidirectional decision, isolated as a pure function so the rule is
// testable without a DB or a live Jira.
//
// Agreement wins first: when both sides already show the same state there is
// nothing to do, whatever the timestamps say. That single check is what makes
// loop prevention structural — a sync-driven write leaves the sides equal, so
// the following cycle decides "none" and the ping-pong never starts.
//
// Otherwise the side whose status changed more recently wins. Ties go to `pull`
// (Jira is the human-curated side, so it is the safer default when hive cannot
// tell the two apart).
export function decideStatusSync(args: {
  jiraState: State | null; // mapped Jira status, null = unmappable
  hiveState: State;
  jiraAt: number;
  hiveAt: number;
}): SyncAction {
  const { jiraState, hiveState, jiraAt, hiveAt } = args;
  if (jiraState == null) return "none"; // unknown Jira status: never guess
  if (jiraState === hiveState) return "none"; // agreed
  // needs_decision is a hive-only state carried as a LABEL, not a status. It
  // must not be pushed as a status, and Jira must not overwrite it just for
  // having no equivalent — the issue keeps whatever status it had.
  if (hiveState === "needs_decision") return "none";
  if (stateToJiraStatus(hiveState) == null) return "none"; // failed/cancelled: no Jira meaning
  return hiveAt > jiraAt ? "push" : "pull";
}

// The credential is the (site, email) PAIR: pinning only the host would still
// let a config write swap the identity half of email:token. EXACT host match,
// not a `*.atlassian.net` suffix check — Atlassian Cloud sites are self-serve,
// so an attacker can register their own for free and a suffix check waves
// them through.
export function credentialTargetAllowed(site: unknown, email: unknown): boolean {
  if (typeof site !== "string" || typeof email !== "string") return false;
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false; // Basic auth over http is base64 on the wire, not encryption
  // Reject any "@" in the raw string outright, before relying on parsed fields. new URL()
  // normalizes away empty userinfo (e.g. "https://@host" parses to username="" password="")
  // and slash/backslash forms (e.g. "https:/@host", "https:////@host"), so u.username/u.password
  // can't be trusted to catch every representation of a userinfo delimiter. ALLOWED_SITE never
  // contains "@" under any spelling, so this can't reject a legitimate value.
  if (site.includes("@")) return false;
  if (u.host !== ALLOWED_HOST) return false; // host, not hostname: a port makes it a different endpoint
  return email === ALLOWED_EMAIL;
}

// ------------------------------------------------------------------ jira api
// The status has to survive as a FIELD, not as text inside the message: the
// deletion disposition below turns on a 404 specifically, and scraping a
// number back out of a formatted string is exactly the kind of match that
// silently starts matching the wrong thing.
export class JiraHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class JiraClient {
  constructor(
    private cfg: JiraConfig,
    private token: string,
    private fetchImpl: FetchLike = fetch
  ) {
    // Belt-and-suspenders: JiraConfig is a plain interface, so a hand-built
    // literal would otherwise satisfy the type and reach auth() unchecked.
    if (!credentialTargetAllowed(cfg.site, cfg.email)) {
      throw new Error(`jira: refusing to build a client for disallowed target ${cfg.site} <${cfg.email}>`);
    }
  }

  private auth(): string {
    return "Basic " + Buffer.from(`${this.cfg.email}:${this.token}`).toString("base64");
  }

  async call(path: string, init: RequestInit = {}): Promise<any> {
    const res = await this.fetchImpl(`${this.cfg.site}${path}`, {
      ...init,
      headers: {
        Authorization: this.auth(),
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok)
      throw new JiraHttpError(`jira ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`, res.status);
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // All issues in the configured project, with the changelog the conflict rule
  // needs. `/rest/api/3/search` is REMOVED (410) — `/search/jql` replaced it.
  async issues(): Promise<any[]> {
    const jql = [`project = ${this.cfg.project_key}`, this.cfg.jql].filter(Boolean).join(" AND ");
    const out: any[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({
        jql,
        fields: "summary,description,status,assignee,labels,priority,issuetype,created,updated",
        expand: "changelog",
        maxResults: "100",
      });
      if (token) q.set("nextPageToken", token);
      const body = await this.call(`/rest/api/3/search/jql?${q}`);
      out.push(...(body?.issues ?? []));
      token = body?.nextPageToken;
      if (body?.isLast !== false || !token) break;
    }
    return out;
  }

  // Positive proof that an issue is GONE, which is a different question from
  // "did the search return it". Jira's search index is eventually consistent
  // and `issues()` above also truncates at MAX_PAGES, so an issue can be absent
  // from that result while existing perfectly well; only a direct per-issue GET
  // separates the two. 404 is the single outcome that answers "gone" — a 200
  // says it is there, and a 5xx/timeout/auth failure PROPAGATES, because
  // "hive could not tell" must never reach a caller as "it is gone".
  async issueMissing(key: string): Promise<boolean> {
    try {
      await this.call(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=key`);
      return false;
    } catch (e) {
      if (e instanceof JiraHttpError && e.status === 404) return true;
      throw e;
    }
  }

  async accountId(): Promise<string | null> {
    return (await this.call("/rest/api/3/myself"))?.accountId ?? null;
  }

  async comments(key: string): Promise<any[]> {
    const out: any[] = [];
    let startAt = 0;
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      const q = new URLSearchParams({ startAt: String(startAt), maxResults: "100", orderBy: "created", expand: "properties" });
      const body = await this.call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?${q}`);
      const comments = body?.comments ?? [];
      out.push(...comments);
      startAt += comments.length;
      if (!comments.length || startAt >= Number(body?.total ?? startAt)) break;
    }
    return out;
  }

  async addComment(key: string, text: string, eventId: string): Promise<any> {
    return await this.call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: textToAdf(text),
        properties: [{ key: HIVE_COMMENT_PROPERTY, value: eventId }],
      }),
    });
  }

  // Move an issue to a target status by NAME. Jira transitions are identified by
  // transition id, not target status, so the available list is resolved first.
  async transitionTo(key: string, statusName: string): Promise<void> {
    const body = await this.call(`/rest/api/3/issue/${key}/transitions`);
    const want = statusName.trim().toLowerCase();
    const t = (body?.transitions ?? []).find((x: any) => String(x?.to?.name ?? "").trim().toLowerCase() === want);
    if (!t) throw new Error(`no transition to '${statusName}' available on ${key}`);
    await this.call(`/rest/api/3/issue/${key}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: t.id } }),
    });
  }

  async setLabel(key: string, label: string, present: boolean): Promise<void> {
    await this.call(`/rest/api/3/issue/${key}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: [present ? { add: label } : { remove: label }] } }),
    });
  }

  async setAssignee(key: string, accountId: string | null): Promise<void> {
    await this.call(`/rest/api/3/issue/${key}/assignee`, {
      method: "PUT",
      body: JSON.stringify({ accountId }),
    });
  }
}

// --------------------------------------------------------------- hive writes
export function briefFor(issue: any, site: string): string {
  const f = issue.fields ?? {};
  return [
    `JIRA: ${site}/browse/${issue.key}`,
    `Type: ${f.issuetype?.name ?? "-"}`,
    `Priority: ${f.priority?.name ?? "-"}`,
    `Assignee: ${f.assignee?.displayName ?? "Unassigned"}`,
    `Labels: ${(f.labels ?? []).join(", ") || "-"}`,
    "",
    adfToText(f.description).trim() || "(no description)",
  ].join("\n");
}

// Mirror the mapped state onto a tracking-only task WITHOUT walking hive's
// forward state machine.
//
// Deliberate bypass, and the reason is the mismatch between the two models: a
// human dragging a ticket To Do -> Done in one click is ordinary in Jira, but
// queued -> done is not a legal hive transition, and stepping it through
// in_progress/in_review/verifying would emit four state_change events (and
// four manager notifications) for that one click. hive's state machine exists
// to protect ITS OWN review workflow, which is meaningless for a ticket hive
// never dispatches. Guarded to jira-linked tasks so it can never be reached for
// a real hive work item.
export function applyJiraState(db: DB, task: any, to: State, reason: string): void {
  if (!String(task.source_ref ?? "").startsWith(REF_PREFIX)) {
    throw new Error(`refusing to force state on non-jira task ${task.id}`);
  }
  if (task.state === to) return;
  db.query("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(to, now(), task.id);
  writeEvent(db, {
    task_id: task.id,
    source: "jira-sync",
    type: "state_change",
    payload: { from: task.state, to, reason },
  });
  broadcastTask(db, getTask(db, task.id));
}

// Every overwrite is logged with both sides and who won, so a "hive silently
// changed my ticket" complaint is always answerable after the fact.
function logSync(
  db: DB,
  taskId: string,
  payload: Record<string, unknown>
): void {
  writeEvent(db, { task_id: taskId, source: "jira-sync", type: "jira_sync", payload });
}

// ------------------------------------------------------------------ the loop
export function jiraConfig(raw: any): JiraConfig | null {
  const j = raw?.jira;
  if (!j || typeof j !== "object") return null;
  if (!j.site || !j.email || !j.project_key) return null;
  const email = String(j.email);
  const projectKey = String(j.project_key);
  if (!credentialTargetAllowed(j.site, email)) return null;
  if (!ALLOWED_PROJECT_KEYS.includes(projectKey)) return null;
  // Canonicalize to hive's OWN constants, not the caller's strings, so no
  // unvalidated remnant reaches fetch() or the Authorization header.
  return {
    site: ALLOWED_SITE,
    email: ALLOWED_EMAIL,
    project_key: projectKey,
    enabled: j.enabled === true,
    write: j.write === true,
    jql: typeof j.jql === "string" ? j.jql : undefined,
  };
}

export interface SyncStats {
  imported: number;
  pushed: number;
  pulled: number;
  labeled: number;
  assigned: number;
  comments_pulled: number;
  comments_pushed: number;
  shadow: number; // outbound calls suppressed by write:false
  cancelled: number; // mirrors dispositioned because their issue is proven gone
  errors: number;
}

function commentProperty(comment: any, key: string): string | null {
  const property = (comment?.properties ?? []).find((p: any) => p?.key === key);
  return property?.value == null ? null : String(property.value);
}

function jiraCommentRecorded(db: DB, taskId: string, jiraId: string): boolean {
  return !!db.query(
    `SELECT 1 FROM events
     WHERE task_id = ? AND (
       (type = 'jira_comment' AND json_extract(payload, '$.jira_id') = ?)
       OR (type = 'jira_sync' AND json_extract(payload, '$.jira_comment_id') = ?)
     ) LIMIT 1`
  ).get(taskId, jiraId, jiraId);
}

// Did hive's own deletion sweep cancel this mirror, or did a human? Only the
// former may be undone when the issue comes back — a director who cancels a
// mirrored task means it, and the sync must not resurrect it. The most recent
// state_change already carries the answer in its `source`, so this needs no
// extra marker column to drift out of step with the transition that sets it.
function cancelledByJiraSync(db: DB, taskId: string): boolean {
  const r = db
    .query("SELECT source, payload FROM events WHERE task_id = ? AND type = 'state_change' ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(taskId) as { source: string; payload: string } | undefined;
  if (r?.source !== "jira-sync") return false;
  try {
    return JSON.parse(r.payload)?.to === "cancelled";
  } catch {
    return false;
  }
}

function commentPushRecorded(db: DB, taskId: string, eventId: string, action: string): boolean {
  return !!db.query(
    `SELECT 1 FROM events
     WHERE task_id = ? AND type = 'jira_sync'
       AND json_extract(payload, '$.action') = ?
       AND json_extract(payload, '$.event_id') = ? LIMIT 1`
  ).get(taskId, action, eventId);
}

export async function syncProjectOnce(
  db: DB,
  projectId: string,
  cfg: JiraConfig,
  client: JiraClient,
  deps: JiraDeps = {}
): Promise<SyncStats> {
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[hive] jira: ${m}`, e ?? ""));
  const stats: SyncStats = {
    imported: 0, pushed: 0, pulled: 0, labeled: 0, assigned: 0,
    comments_pulled: 0, comments_pushed: 0, shadow: 0, cancelled: 0, errors: 0,
  };
  const issues = await client.issues();
  let selfId: string | null = null;

  for (const issue of issues) {
    try {
      const ref = REF_PREFIX + issue.key;
      const jiraState = jiraStatusToState(issue.fields?.status?.name);
      let task = db.query("SELECT * FROM tasks WHERE source_ref = ?").get(ref) as any;

      // ---- import: an issue hive has never seen becomes a tracking-only task
      if (!task) {
        const id = newId();
        const t = now();
        db.query(
          `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at)
           VALUES (?,?,?,?,?, 'ship', 'external', ?, ?, ?)`
        ).run(id, projectId, `[${issue.key}] ${issue.fields?.summary ?? "(no summary)"}`,
          briefFor(issue, cfg.site), jiraState ?? "queued", ref, t, t);
        task = getTask(db, id);
        logSync(db, id, { action: "import", issue: issue.key, jira_status: issue.fields?.status?.name, state: task.state });
        broadcast({ type: "task", task });
        stats.imported++;
      }

      // ---- JIRA-owned fields always flow JIRA -> hive (hive never rewrites them)
      const title = `[${issue.key}] ${issue.fields?.summary ?? "(no summary)"}`;
      const brief = briefFor(issue, cfg.site);
      if (task.title !== title || task.brief !== brief) {
        db.query("UPDATE tasks SET title = ?, brief = ?, updated_at = ? WHERE id = ?").run(title, brief, now(), task.id);
        broadcastTask(db, getTask(db, task.id));
      }

      // ---- reappearance: undo a deletion disposition when the issue is back.
      // The 404 the sweep below acts on proves the issue is not READABLE by
      // hive, which is deletion in all but one case: Jira answers 404 rather
      // than 403 for an issue you have lost permission to see, deliberately,
      // so it does not leak existence. That makes the cancellation presumptive,
      // and a presumptive terminal state has to be reversible or a permission
      // blip becomes a permanent one-way trapdoor. Seeing the issue again is
      // itself positive evidence, so it is safe to act on.
      if (task.state === "cancelled" && cancelledByJiraSync(db, task.id)) {
        logSync(db, task.id, { action: "source_restored", issue: issue.key, state: jiraState ?? "queued" });
        applyJiraState(db, task, jiraState ?? "queued", `jira ${issue.key} exists again`);
        task = getTask(db, task.id);
      }

      // ---- status: bidirectional alongside comments
      const jiraAt = lastStatusChangeAt(issue);
      const hiveAt = lastStateChangeAt(db, task.id);
      const action = decideStatusSync({ jiraState, hiveState: task.state, jiraAt, hiveAt });

      if (action === "pull") {
        logSync(db, task.id, {
          action: "pull", issue: issue.key, field: "status", winner: "jira",
          from: task.state, to: jiraState, jira_at: new Date(jiraAt).toISOString(), hive_at: new Date(hiveAt).toISOString(),
        });
        applyJiraState(db, task, jiraState!, `jira ${issue.key} -> ${issue.fields?.status?.name}`);
        task = getTask(db, task.id);
        stats.pulled++;
      } else if (action === "push") {
        const target = stateToJiraStatus(task.state)!;
        const entry = {
          action: "push", issue: issue.key, field: "status", winner: "hive",
          from: issue.fields?.status?.name, to: target,
          jira_at: new Date(jiraAt).toISOString(), hive_at: new Date(hiveAt).toISOString(),
        };
        if (cfg.write) {
          await client.transitionTo(issue.key, target);
          logSync(db, task.id, entry);
          stats.pushed++;
        } else {
          logSync(db, task.id, { ...entry, shadow: true });
          stats.shadow++;
        }
      }

      // ---- needs_decision rides as a label, since Jira has no such status
      const wantLabel = task.state === "needs_decision";
      const hasLabel = (issue.fields?.labels ?? []).includes(NEEDS_DECISION_LABEL);
      if (wantLabel !== hasLabel) {
        const entry = { action: "label", issue: issue.key, label: NEEDS_DECISION_LABEL, present: wantLabel };
        if (cfg.write) {
          await client.setLabel(issue.key, NEEDS_DECISION_LABEL, wantLabel);
          logSync(db, task.id, entry);
          stats.labeled++;
        } else {
          logSync(db, task.id, { ...entry, shadow: true });
          stats.shadow++;
        }
      }

      // ---- assignee is hive-owned: work in flight on hive shows as assigned.
      // There is no hive-agent -> Jira-user mapping (and no reason to invent
      // one), so "someone is on this" is expressed as the sync account itself.
      const active = task.state === "in_progress" || task.state === "in_review" || task.state === "verifying";
      const assigneeId = issue.fields?.assignee?.accountId ?? null;
      if (active && !assigneeId) {
        if (cfg.write) {
          selfId ??= await client.accountId();
          if (selfId) {
            await client.setAssignee(issue.key, selfId);
            logSync(db, task.id, { action: "assign", issue: issue.key, account_id: selfId });
            stats.assigned++;
          }
        } else {
          logSync(db, task.id, { action: "assign", issue: issue.key, shadow: true });
          stats.shadow++;
        }
      } else if (!active && assigneeId) {
        selfId ??= await client.accountId();
        if (assigneeId === selfId) {
          if (cfg.write) {
            await client.setAssignee(issue.key, null);
            logSync(db, task.id, { action: "unassign", issue: issue.key, account_id: selfId });
            stats.assigned++;
          } else {
            logSync(db, task.id, { action: "unassign", issue: issue.key, shadow: true });
            stats.shadow++;
          }
        }
      }

      // ---- comments: Jira comments become timeline messages; Hive comments
      // are an outbox until Jira acknowledges them. The Jira comment property
      // heals a crash between the remote write and the local receipt, so a
      // retry cannot duplicate a comment.
      const jiraComments = await client.comments(issue.key);
      const remoteHiveEvents = new Map<string, string>();
      for (const comment of jiraComments) {
        const eventId = commentProperty(comment, HIVE_COMMENT_PROPERTY);
        if (eventId) {
          remoteHiveEvents.set(eventId, String(comment.id));
          continue;
        }
        const jiraId = String(comment.id ?? "");
        if (!jiraId || jiraCommentRecorded(db, task.id, jiraId)) continue;
        writeEvent(db, {
          task_id: task.id,
          source: "jira",
          type: "jira_comment",
          payload: {
            direction: "inbound",
            jira_id: jiraId,
            issue: issue.key,
            author: comment.author?.displayName ?? comment.author?.accountId ?? "Jira",
            text: adfToText(comment.body).trim(),
            created: comment.created ?? null,
          },
        });
        stats.comments_pulled++;
      }

      const pending = db.query(
        `SELECT id, payload FROM events
         WHERE task_id = ? AND type = 'jira_comment' AND source != 'jira'
           AND json_extract(payload, '$.direction') = 'outbound'
         ORDER BY ts`
      ).all(task.id) as { id: string; payload: string }[];
      for (const event of pending) {
        if (commentPushRecorded(db, task.id, event.id, "comment_push")) continue;
        const remoteId = remoteHiveEvents.get(event.id);
        if (remoteId) {
          logSync(db, task.id, { action: "comment_push", issue: issue.key, event_id: event.id, jira_comment_id: remoteId, recovered: true });
          continue;
        }
        const text = String(JSON.parse(event.payload)?.text ?? "").trim();
        if (!text) continue;
        if (cfg.write) {
          const comment = await client.addComment(issue.key, text, event.id);
          logSync(db, task.id, { action: "comment_push", issue: issue.key, event_id: event.id, jira_comment_id: String(comment?.id ?? "") });
          stats.comments_pushed++;
        } else if (!commentPushRecorded(db, task.id, event.id, "comment_shadow")) {
          logSync(db, task.id, { action: "comment_shadow", issue: issue.key, event_id: event.id, shadow: true });
          stats.shadow++;
        }
      }
    } catch (e) {
      stats.errors++;
      log(`issue ${issue?.key} failed`, e);
    }
  }

  // ---- disposition: a mirror whose issue is PROVEN gone stops being queued
  // forever. Without this a deleted Jira issue leaves a tracking task sitting
  // in the inbox with one import event on it, never updated again and with
  // nothing on the task saying why.
  //
  // The two-step shape is the whole safety property, and the steps answer
  // different questions. Absence from `issues()` only SELECTS CANDIDATES: it is
  // not evidence of anything, since the search index lags and the page cap can
  // truncate. The consequence is driven exclusively by `issueMissing`, a direct
  // read whose 404 is a positive signal. A candidate that turns out to be
  // present, or that hive fails to reach at all, is left completely untouched —
  // no state change, no event, nothing that a later cycle has to undo.
  //
  // The row itself is never deleted: comments, evidence and receipts hang off
  // it and are the only surviving record that the work existed. `cancelled` is
  // terminal, so the mirror also leaves the board and the attention tray, which
  // is the point — it becomes history instead of clutter.
  const seenKeys = new Set(issues.map((i: any) => String(i?.key ?? "")));
  const linked = db
    .query(
      `SELECT id, source_ref FROM tasks
       WHERE project_id = ? AND source_ref LIKE ?
         AND state NOT IN (${TERMINAL.map(() => "?").join(",")})`
    )
    .all(projectId, REF_PREFIX + "%", ...TERMINAL) as { id: string; source_ref: string }[];
  for (const row of linked) {
    const key = String(row.source_ref).slice(REF_PREFIX.length);
    if (seenKeys.has(key)) continue;
    try {
      if (!(await client.issueMissing(key))) continue; // still there: absent from search only
      logSync(db, row.id, { action: "source_deleted", issue: key, proof: "direct GET returned 404" });
      transition(db, row.id, "cancelled", {
        source: "jira-sync",
        reason: `jira ${key} no longer exists (direct read returned 404)`,
      });
      stats.cancelled++;
    } catch (e) {
      stats.errors++;
      log(`issue ${key} deletion check failed`, e);
    }
  }
  return stats;
}

// One cycle across every project that opted in. Hard no-op when none have.
export async function syncJiraOnce(db: DB, deps: JiraDeps = {}): Promise<SyncStats[]> {
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[hive] jira: ${m}`, e ?? ""));
  const out: SyncStats[] = [];
  const projects = db.query("SELECT id, config FROM projects").all() as { id: string; config: string }[];
  for (const p of projects) {
    let cfg: JiraConfig | null = null;
    try {
      cfg = jiraConfig(JSON.parse(p.config || "{}"));
    } catch {
      continue;
    }
    if (!cfg?.enabled) continue;
    try {
      const token = deps.token ?? (await resolveProjectSecrets(db, p.id, deps.exec ?? defaultExec)).JIRA_API_TOKEN;
      if (!token) {
        log(`project ${p.id} enabled but JIRA_API_TOKEN is not resolvable; skipping`);
        continue;
      }
      const client = new JiraClient(cfg, token, deps.fetch ?? fetch);
      const stats = await syncProjectOnce(db, p.id, cfg, client, deps);
      out.push(stats);
      if (stats.imported || stats.pushed || stats.pulled || stats.labeled || stats.assigned || stats.comments_pulled || stats.comments_pushed || stats.shadow || stats.cancelled || stats.errors)
        console.log(
          `[hive] jira ${cfg.project_key}: +${stats.imported} imported, ${stats.pushed} pushed, ${stats.pulled} pulled, ${stats.labeled} labeled, ${stats.assigned} assigned, ${stats.comments_pulled} comments in, ${stats.comments_pushed} comments out, ${stats.shadow} shadow, ${stats.cancelled} cancelled, ${stats.errors} errors`
        );
    } catch (e) {
      log(`project ${p.id} sync failed`, e);
    }
  }
  return out;
}

export function startJiraSync(db: DB, deps: JiraDeps = {}): () => void {
  const intervalMs = deps.intervalMs ?? Number(process.env.HIVE_JIRA_SYNC_MS || 60_000);
  const timer = setInterval(() => {
    syncJiraOnce(db, deps).catch((e) => console.error("[hive] jira sync crashed:", e));
  }, intervalMs);
  return () => clearInterval(timer);
}
