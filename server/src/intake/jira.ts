// JIRA <-> hive bidirectional sync (Atlassian Jira Cloud).
//
// Mirrors issues from one Jira project onto the hive board and keeps `status`
// in step in BOTH directions. Hard no-op until a project opts in, same as the
// gchat intake connector.
//
// Config lives on the project row (`projects.config.jira`):
//   { site: "https://corebeat.atlassian.net", email: "corebeat@vid.kim",
//     project_key: "WEB", enabled: false, write: false, jql?: "..." }
// It must pass the compiled-in credential and project allowlist below before
// any secret resolves.
// `enabled` is the master switch; `write` is a separate SHADOW-MODE gate — with
// enabled:true / write:false the sync imports and computes every outbound call
// but LOGS it instead of sending, so the director can read one cycle of "would
// have done X" before hive ever edits a real issue. Shadow mode is a real,
// tested config state, exercised on the FIRST cycle (see importAndReconcile).
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
//   already persists a per-key scalar, which is where the absence streak lives.
//
// * Converging reconciler, not webhooks. hive binds loopback and has no public
//   ingress, so Jira Cloud cannot reach it; polling is the only transport that
//   works without exposing the box. That turns out to be the better design
//   anyway: each cycle writes ONLY when the two sides actually differ, so once a
//   write lands both sides agree and the next cycle finds nothing to do. Loop
//   prevention is therefore structural rather than a marker every code path has
//   to remember to check.
//
// * Search is DISCOVERY-ONLY. Jira's enhanced search is eventually consistent,
//   so its result set is treated as a list of candidate keys and nothing else.
//   Every per-issue decision derives from one fresh, strongly-consistent read
//   taken at the point of decision for that issue (see readIssue), and every
//   Jira write re-reads immediately before acting (see guardedWrite).
//
// * Status and its timestamp come from the SAME changelog record, never from
//   two separate reads paired together. `fields.updated` only brackets that
//   read as a version marker; it never participates in the status tiebreak.
//
// * Imported issues are tracking-only (`source='external'`): the dispatcher
//   skips them (dispatcher.ts), the reconciler's stale sweep skips them
//   (reconciler.ts), and the done-gate evidence requirement is skipped
//   (state.ts), since a ticket a human closed in Jira will never have a hive PR.
import type { DB } from "../db.ts";
import { isOffline, newId, now } from "../db.ts";
import { writeEvent, mutateWithEvent, getTask, transition, TERMINAL, type State } from "../state.ts";
import { broadcastTask } from "../health.ts";
import { resolveProjectSecrets } from "../secrets.ts";
import type { Exec } from "../exec.ts";
import { defaultExec } from "../exec.ts";
import {
  NEEDS_DECISION_LABEL,
  assertJiraWriteAllowed,
  type JiraWriteField,
} from "./jira-write-scope.ts";

export { NEEDS_DECISION_LABEL, JIRA_WRITE_SCOPE } from "./jira-write-scope.ts";

export type FetchLike = typeof fetch;

export const SOURCE = "jira";
export const REF_PREFIX = "jira:"; // tasks.source_ref = jira:WEB-7
export const JIRA_COMMENT_MAX_LENGTH = 32_767;
const MAX_PAGES = 20; // paging backstop, 100 issues/page
const COMMENT_PAGE = 100;
// Idempotency keys. hive stamps every comment it writes with a Jira comment
// PROPERTY naming the local row that produced it. A later cycle can recover a
// missing local receipt from that property. Jira does not enforce property
// uniqueness, so an unconfirmed request is contained and surfaced, never
// knowingly retried.
const HIVE_COMMENT_PROPERTY = "hive.event_id";
const HIVE_EVIDENCE_PROPERTY = "hive.evidence_id";
const CHANGELOG_PAGE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
// How many CONSECUTIVE observations of one absence kind must accrue before hive
// stops syncing. Operational failures never count.
const ABSENT_STREAK_LIMIT = 3;
const ABSENT_STOPPED = "stopped"; // terminal marker value in intake_cursors

// ============================================================================
// CREDENTIAL GATE
// ============================================================================
// The ONE Jira deployment hive is compiled to talk to. Both halves of the
// credential pair and the allowed projects are pinned HERE, IN CODE, precisely
// because `projects.config` is attacker-writable through the loopback API:
// `PATCH /api/projects/:id` replaces `config` wholesale with no validation
// (api.ts, updateProject).
//
// Without this gate, a mutated `config.jira.site` makes hive send
// `Authorization: Basic base64(email:token)` — the real JIRA_API_TOKEN — to
// whatever host the attacker named. That leak happens on the READ path, before
// any `write` check runs, so `write: false` does NOT protect against it:
// shadow mode still reads, and reading is all an exfiltration needs.
// A mutated project key cannot exfiltrate the token, but it could silently make
// hive edit issues outside the project this integration was scoped to.
//
// Deliberately an EXACT host match, NOT a `*.atlassian.net` suffix check.
// Atlassian Cloud sites are self-serve: an attacker can register their own
// atlassian.net site for free, so a suffix check would wave them straight
// through and reduce the attack surface by approximately nothing.
//
// Adding a second Jira deployment is a PR, not a runtime config write. That
// cost is the point.
const ALLOWED_HOST = "corebeat.atlassian.net";
export const ALLOWED_SITE = `https://${ALLOWED_HOST}`;
export const JIRA_SITE = ALLOWED_SITE; // legacy alias
export const ALLOWED_EMAIL = "corebeat@vid.kim";
const ALLOWED_PROJECT_KEYS = ["WEB"] as const;

function allowedProjectKey(value: unknown): string | null {
  const candidate = String(value ?? "");
  return ALLOWED_PROJECT_KEYS.find((key) => key === candidate) ?? null;
}

// True only for the exact compiled-in credential target. Exported for tests.
//
// Fails CLOSED in every direction: anything it cannot positively confirm is a
// rejection, and the caller (jiraConfig) turns a rejection into `null` — a hard
// no-op — rather than a throw that a `catch` upstream could swallow into
// "log it and carry on".
export function credentialTargetAllowed(site: unknown, email: unknown): boolean {
  // Type-reject rather than coerce: String(someObject) can manufacture a
  // passing value out of something that was never a string.
  if (typeof site !== "string" || typeof email !== "string") return false;
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return false; // unparseable / empty
  }
  // Basic auth over http puts `email:token` on the wire in base64, which is
  // encoding, not encryption. Rejected outright — never downgraded, never
  // "upgraded" silently to https on the caller's behalf.
  if (u.protocol !== "https:") return false;
  // Reject ANY "@" in the raw string, before trusting parsed fields.
  // `https://corebeat.atlassian.net@evil.tld/` parses with host `evil.tld` but
  // reads as the real site to a human skimming config. new URL() also
  // normalizes away empty userinfo ("https://@host" -> username="") and
  // slash/backslash forms ("https:/@host", "https:////@host"), so
  // u.username/u.password cannot catch every spelling. ALLOWED_SITE never
  // contains "@", so this can never reject a legitimate value.
  if (site.includes("@")) return false;
  // Exact host, including port: `corebeat.atlassian.net:8443` is a different
  // endpoint and does not inherit the real site's trust.
  if (u.host !== ALLOWED_HOST) return false;
  // The credential is the PAIR. Pinning only the host would still let a config
  // write swap the identity half of `email:token`.
  return email === ALLOWED_EMAIL;
}

// ============================================================================
// CONFIG
// ============================================================================
export interface JiraConfig {
  site: string;
  email: string;
  project_key: string;
  enabled: boolean;
  write: boolean; // false = shadow mode (compute + log, never send)
  jql?: string; // extra filter, ANDed with project = <key>
}

export interface JiraConfigStatus {
  config: JiraConfig | null;
  error: string | null;
}

function validatedJqlFilter(value: unknown): string | undefined | null {
  if (value == null) return undefined;
  if (typeof value !== "string") return null;
  const jql = value.trim();
  if (!jql) return undefined;

  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const char of jql) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth < 0) return null;
    else if (char < " ") return null;
  }
  return quote || escaped || depth !== 0 ? null : jql;
}

// Parse + gate. Returns null (hard no-op) for anything not exactly right.
//
// This is the ONLY way to obtain a JiraConfig, and JiraClient refuses to be
// constructed without one whose credential target still passes — so the gate
// sits structurally upstream of secret resolution and of the auth header, not
// merely earlier in a function someone might later reorder.
function jiraConfigStatus(raw: any): JiraConfigStatus {
  const j = raw?.jira;
  if (!j || typeof j !== "object") return { config: null, error: null };
  const projectKey = allowedProjectKey(j.project_key);
  const jql = validatedJqlFilter(j.jql);

  // ---- credential gate, BEFORE anything else touches the network or a secret
  if (!credentialTargetAllowed(j.site, j.email) || !projectKey) return { config: null, error: null };
  if (jql === null) {
    const value = JSON.stringify(j.jql);
    return {
      config: null,
      error: `config.jira.jql is invalid: ${value === undefined ? String(j.jql) : value.slice(0, 200)}`,
    };
  }

  return {
    config: {
      // Canonicalized to the compiled-in constants on purpose: the strings that
      // reach fetch() and the Authorization header are hive's own, never the
      // caller's, so no unvalidated remnant of the config value can survive.
      site: JIRA_SITE,
      email: ALLOWED_EMAIL,
      project_key: projectKey,
      enabled: j.enabled === true,
      write: j.write === true,
      jql,
    },
    error: null,
  };
}

export function jiraConfig(raw: any): JiraConfig | null {
  return jiraConfigStatus(raw).config;
}

// ============================================================================
// STATUS MAPPING
// ============================================================================
// The WEB workflow (To Do -> In Progress -> In Review -> Done) is Jira's
// untouched team-managed default and is shared by every issue type there.
export const JIRA_TO_STATE: Record<string, State> = {
  "to do": "queued",
  "in progress": "in_progress",
  "in review": "in_review",
  done: "done",
};

// hive -> Jira. Deliberately partial:
//  * needs_decision has NO Jira status; it rides as a LABEL on top of whatever
//    status the issue already has (that is why it maps to null, not a state).
//  * verifying means "merged, smoke checks pending" — still not Done to a human
//    reading the board, so it shows as In Review. NOTE this makes the mapping
//    2:1 (in_review and verifying both -> "In Review"); every agreement check
//    below therefore compares in JIRA-STATUS SPACE, never hive-state space,
//    because `in_review === verifying` is false while the sides genuinely agree.
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
  const key = String(name ?? "").trim().toLowerCase();
  return Object.hasOwn(JIRA_TO_STATE, key) ? JIRA_TO_STATE[key] : null;
}

export function stateToJiraStatus(state: string): string | null {
  return Object.hasOwn(STATE_TO_JIRA, state) ? STATE_TO_JIRA[state as State] ?? null : null;
}

const sameStatus = (a: string | null, b: string | null): boolean =>
  a != null && b != null && a.trim().toLowerCase() === b.trim().toLowerCase();

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

// The inverse of adfToText, for the comments hive writes. Jira rejects a bare
// string body on API v3, so plain text has to be wrapped as a document. An
// empty line becomes an empty paragraph rather than a paragraph containing an
// empty text node, which Jira rejects.
export function textToAdf(text: string): any {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => {
      const content: any[] = [];
      let offset = 0;
      for (const match of line.matchAll(/https?:\/\/\S+/g)) {
        const index = match.index;
        if (index > offset) content.push({ type: "text", text: line.slice(offset, index) });
        const href = match[0];
        content.push({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] });
        offset = index + href.length;
      }
      if (offset < line.length) content.push({ type: "text", text: line.slice(offset) });
      return { type: "paragraph", ...(content.length ? { content } : {}) };
    }),
  };
}

// ============================================================================
// TIMESTAMPS
// ============================================================================
// When the HIVE task's mirrored status last actually moved.
//
// Not "when the task last transitioned": hive has states Jira cannot express,
// and a round trip through one of them must stay INVISIBLE to the comparison.
// in_progress -> needs_decision -> in_progress leaves the Jira-visible status
// ("In Progress") exactly where it was, so it must not refresh the timestamp and
// let hive win a tiebreak it did not earn.
//
// So: walk the state_change history in order, tracking the Jira status the task
// CARRIES. A state with no Jira mapping (needs_decision, failed, cancelled)
// leaves the carried value unchanged rather than clearing it. The answer is the
// newest moment the carried value genuinely changed.
//
// This deliberately still counts a requeue (failed -> queued): `queued` has a
// real mapping ("To Do") and the carried value truly moves, so that IS a status
// change. Discarding every event with an unmapped endpoint would drop it.
export function lastStateChangeAt(db: DB, taskId: string): number | null {
  const created = db.query("SELECT created_at FROM tasks WHERE id = ?").get(taskId) as
    | { created_at: string }
    | undefined;
  const createdAt = Date.parse(created?.created_at ?? "");
  let movedAt: number | null = Number.isFinite(createdAt) ? createdAt : null;

  const imported = db
    .query("SELECT payload FROM events WHERE task_id = ? AND source = 'jira-sync' AND type = 'jira_sync' AND json_extract(payload, '$.action') = 'import' ORDER BY ts ASC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (imported) {
    try {
      const payload = JSON.parse(imported.payload);
      const t = Date.parse(String(payload.action === "import" ? payload.jira_status_at ?? "" : ""));
      movedAt = Number.isFinite(t) ? t : null;
    } catch {}
  }

  const rows = db
    .query("SELECT ts, source, payload FROM events WHERE task_id = ? AND type = 'state_change' ORDER BY ts ASC")
    .all(taskId) as { ts: string; source: string; payload: string }[];

  let carried: string | null = null;
  let seeded = false;
  for (const row of rows) {
    let payload: { from?: string; to?: string; jira_status_at?: string };
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const { from, to } = payload;
    // Seed the carried value from the FIRST event's `from`, which is the state
    // the task held before any transition (its creation state).
    if (!seeded) {
      carried = stateToJiraStatus(String(from ?? ""));
      seeded = true;
    }
    const mapped = stateToJiraStatus(String(to ?? ""));
    if (mapped == null) continue; // no Jira meaning: carried value stands
    if (sameStatus(mapped, carried)) continue; // same Jira status: nothing moved
    carried = mapped;
    const clock = row.source === "jira-sync" || row.source === "jira" ? payload.jira_status_at : row.ts;
    const t = Date.parse(String(clock ?? ""));
    movedAt = Number.isFinite(t) ? t : null;
  }
  return movedAt;
}

// ============================================================================
// JIRA API
// ============================================================================
function isJiraNotFound(error: unknown): boolean {
  return error instanceof JiraHttpError && error.status === 404;
}

function jiraFailureKind(error: unknown): "missing" | "retryable" | "row_rejected" | "unknown" {
  if (isJiraNotFound(error)) return "missing";
  if (error instanceof JiraHttpError && error.status === 413) return "row_rejected";
  if (error instanceof JiraHttpError && error.status >= 400 && error.status < 500) return "retryable";
  return "unknown";
}

function jiraScalarId(value: unknown, message: string): string {
  const id = typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : "";
  if (!id) throw new Error(message);
  return id;
}

const commentPropertyCodec = {
  encode(id: string): { id: string } {
    const normalized = id.trim();
    if (!normalized) throw new Error("invalid Jira comment property id");
    return { id: normalized };
  },
  decode(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  },
};

function jiraIssueKey(issue: any, label: string): string {
  if (!issue || typeof issue !== "object" || typeof issue.key !== "string" || !issue.key.trim())
    throw new Error(`incomplete ${label} issue response`);
  return issue.key.trim();
}

function validAdfNode(node: any): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.type !== "string" || !node.type.trim())
    return false;
  if (node.type === "text" && (typeof node.text !== "string" || node.text.length === 0)) return false;
  if (node.text !== undefined && typeof node.text !== "string") return false;
  if (node.content !== undefined && (!Array.isArray(node.content) || !node.content.every(validAdfNode))) return false;
  return true;
}

// `updated` is not just a field, it is the VERSION GUARD: the coherence check
// compares the direct read's `updated` against the scope probe's to prove both
// describe the same observation. A value that is merely a nonempty string can
// still be unparseable, and two identical unparseable values compare equal, so
// an A->B->A status change would slip past the guard on a pair of junk clocks.
// Both readers derive their check from HERE so the rule cannot drift apart.
function isJiraTimestamp(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && Number.isFinite(Date.parse(value));
}

const JIRA_ISSUE_FIELD_VALIDATORS = {
  summary: (value: unknown) => typeof value === "string" && !!value.trim(),
  description: (value: unknown) => value === null || (
    validAdfNode(value) && (value as any).type === "doc" && (value as any).version === 1 && Array.isArray((value as any).content)
  ),
  status: (value: unknown) => typeof (value as any)?.name === "string" && !!(value as any).name.trim(),
  assignee: (value: unknown) => value === null || (
    typeof value === "object" && value !== null &&
    ["accountId", "displayName"].some((field) => typeof (value as any)[field] === "string" && !!(value as any)[field].trim())
  ),
  labels: (value: unknown) => Array.isArray(value) && value.every((label) => typeof label === "string" && !!label.trim()),
  priority: (value: unknown) => value === null || (typeof (value as any)?.name === "string" && !!(value as any).name.trim()),
  issuetype: (value: unknown) => typeof (value as any)?.name === "string" && !!(value as any).name.trim(),
  // `created` stays a presence check: it feeds the status clock, which already
  // fails loudly on an unparseable value ("invalid Jira status clock").
  created: (value: unknown) => typeof value === "string" && !!value.trim(),
  updated: isJiraTimestamp,
  project: (value: unknown) => typeof (value as any)?.key === "string" && !!(value as any).key.trim(),
} as const;

export const JIRA_ISSUE_FIELDS = Object.keys(JIRA_ISSUE_FIELD_VALIDATORS) as (keyof typeof JIRA_ISSUE_FIELD_VALIDATORS)[];

function validateJiraIssueFields(issue: any, key: string): void {
  const fields = issue?.fields;
  for (const field of JIRA_ISSUE_FIELDS) {
    if (!fields || !Object.hasOwn(fields, field) || !JIRA_ISSUE_FIELD_VALIDATORS[field](fields[field]))
      throw new Error(`incomplete Jira ${field} response for ${key}`);
  }
}

function jiraComment(comment: any, issueKey: string): any {
  if (!comment || typeof comment !== "object" || Array.isArray(comment))
    throw new Error(`invalid Jira comment for ${issueKey}`);
  const id = jiraScalarId(comment.id, `invalid Jira comment id for ${issueKey}`);
  if (!validAdfNode(comment.body) || comment.body.type !== "doc" || comment.body.version !== 1 || !Array.isArray(comment.body.content))
    throw new Error(`invalid Jira comment body for ${issueKey}`);
  const properties = comment.properties ?? [];
  if (!Array.isArray(properties)) throw new Error(`invalid Jira comment properties for ${issueKey}`);
  for (const property of properties) {
    if (!property || typeof property !== "object" || typeof property.key !== "string" || !property.key.trim() || !("value" in property))
      throw new Error(`invalid Jira comment properties for ${issueKey}`);
    if (
      (property.key === HIVE_COMMENT_PROPERTY || property.key === HIVE_EVIDENCE_PROPERTY) &&
      !commentPropertyCodec.decode(property.value)
    )
      throw new Error(`invalid Jira comment property for ${issueKey}`);
  }
  return { ...comment, id, properties };
}

type JiraPageCursor = number | string | null;

// A partial discovery can feed the absence sweep, a partial changelog can pick
// the wrong sync direction, and partial comments can duplicate a delivery.
async function paginateJira<T>(
  label: string,
  initialCursor: JiraPageCursor,
  fetchPage: (cursor: JiraPageCursor) => Promise<any>,
  readItems: (body: any) => unknown
): Promise<T[]> {
  const out: T[] = [];
  let cursor = initialCursor;
  let expectedTotal: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await fetchPage(cursor);
    const raw = readItems(body);
    if (!Array.isArray(raw)) throw new Error(`incomplete ${label} pagination`);
    const items = raw as T[];
    out.push(...items);

    if (typeof cursor === "number") {
      if (!Number.isSafeInteger(body?.startAt) || body.startAt !== cursor)
        throw new Error(`incomplete ${label} pagination`);
      const next = cursor + items.length;
      const total = body?.total;
      const hasTotal = Number.isSafeInteger(total) && total >= 0;
      const hasLast = typeof body?.isLast === "boolean";
      if (hasTotal) {
        if (expectedTotal !== null && expectedTotal !== total)
          throw new Error(`incomplete ${label} pagination`);
        expectedTotal = total;
      }
      if (expectedTotal === null && !hasLast) throw new Error(`incomplete ${label} pagination`);
      if (
        expectedTotal !== null &&
        (next > expectedTotal ||
          (body.isLast === true && next < expectedTotal) ||
          (body.isLast === false && next >= expectedTotal))
      )
        throw new Error(`incomplete ${label} pagination`);
      if ((expectedTotal !== null && next === expectedTotal) || (expectedTotal === null && body.isLast === true)) return out;
      if (items.length === 0) throw new Error(`incomplete ${label} pagination`);
      cursor = next;
      continue;
    }

    const next = typeof body?.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
    if (body?.isLast === true) {
      if (next) throw new Error(`incomplete ${label} pagination`);
      return out;
    }
    if (!next) throw new Error(`incomplete ${label} pagination`);
    if (next === cursor) throw new Error(`incomplete ${label} pagination`);
    cursor = next;
  }
  throw new Error(`${label} exceeded pagination limit`);
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
    // Belt-and-suspenders: the gate lives in jiraConfig(), but JiraConfig is a
    // plain interface, so a hand-built object literal would otherwise satisfy
    // the type and reach auth(). Re-assert at the point of use so the host and
    // project scope hold structurally, not just by call-order convention.
    const projectKey = allowedProjectKey(cfg.project_key);
    const jql = validatedJqlFilter(cfg.jql);
    if (!credentialTargetAllowed(cfg.site, cfg.email) || !projectKey || jql === null) {
      throw new Error("refusing to build a Jira client for a non-allowlisted target");
    }
    this.cfg = { ...cfg, project_key: projectKey, jql };
  }

  private auth(): string {
    return "Basic " + Buffer.from(`${this.cfg.email}:${this.token}`).toString("base64");
  }

  private async call(
    path: string,
    init: RequestInit = {},
    write?: { field: JiraWriteField; value?: string }
  ): Promise<any> {
    const method = String(init.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      if (!write) throw new Error(`Jira ${method} ${path} has no declared write scope`);
      assertJiraWriteAllowed(write.field, write.value);
    }
    const res = await this.fetchImpl(`${this.cfg.site}${path}`, {
      // A hung request must not stall the whole cycle (and, with the in-flight
      // guard, silently degrade the poll rate to zero).
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...init,
      headers: {
        Authorization: this.auth(),
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      // .catch(() => "") deliberately: a body-read failure must not throw in
      // place of the typed error, since the STATUS is what callers branch on.
      const detail = await res.text().catch(() => "");
      throw new JiraHttpError(`jira ${init.method ?? "GET"} ${path} -> ${res.status} ${detail}`, res.status);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  private async json(
    path: string,
    init: RequestInit = {},
    write?: { field: JiraWriteField; value?: string }
  ): Promise<any> {
    const body = await this.call(path, init, write);
    if (body === null || typeof body !== "object")
      throw new Error(`jira ${init.method ?? "GET"} ${path} returned an invalid JSON body`);
    return body;
  }

  // The project scope as JQL. The user filter is PARENTHESIZED: AND binds
  // tighter than OR, so `project = WEB AND a OR b` means `(project = WEB AND a)
  // OR b` and an OR in the user's filter would escape the project scope
  // entirely, handing hive write access to issues outside WEB.
  jql(): string {
    const base = `project = ${this.cfg.project_key}`;
    return this.cfg.jql ? `${base} AND (${this.cfg.jql})` : base;
  }

  // DISCOVERY ONLY. Returns candidate issue keys and nothing else — no status,
  // no fields. Jira's enhanced search is eventually consistent, so this result
  // set is a hint about what to look at, never an input to a decision.
  // `fields=key` is the minimal projection that still carries the key.
  async discover(): Promise<string[]> {
    const issues = await paginateJira<any>(
      "Jira discovery",
      null,
      async (cursor) => {
        const q = new URLSearchParams({ jql: this.jql(), fields: "key", maxResults: "100" });
        if (typeof cursor === "string") q.set("nextPageToken", cursor);
        return this.json(`/rest/api/3/search/jql?${q}`);
      },
      (body) => body?.issues
    );
    return issues.map((issue) => jiraIssueKey(issue, "Jira discovery"));
  }

  // Strongly-consistent single-issue read. This — not search — is what every
  // decision is derived from.
  async issue(key: string): Promise<any> {
    const q = new URLSearchParams({
      fields: JIRA_ISSUE_FIELDS.join(","),
    });
    return this.json(`/rest/api/3/issue/${encodeURIComponent(key)}?${q}`);
  }

  // FULL status history from the dedicated, properly paginated changelog
  // endpoint (startAt/maxResults/total/isLast, oldest first).
  //
  // Search's `expand=changelog` caps at 20 entries, so on a busy issue the
  // newest status transition falls outside the window. Reading that and falling
  // back to issue-creation time would make Jira look permanently ancient and
  // let hive win every future tiebreak against a human's recent change.
  async statusHistory(key: string): Promise<{ at: number; to: string }[]> {
    const values = await paginateJira<any>(
      `Jira changelog for ${key}`,
      0,
      async (cursor) => {
        const q = new URLSearchParams({ startAt: String(cursor), maxResults: String(CHANGELOG_PAGE) });
        return this.json(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog?${q}`);
      },
      (body) => body?.values
    );
    const out: { at: number; to: string }[] = [];
    for (const h of values) {
      if (!h || !Array.isArray(h.items)) throw new Error(`invalid Jira changelog record for ${key}`);
      const at = Date.parse(h.created ?? "");
      if (!Number.isFinite(at)) throw new Error(`invalid Jira status history timestamp for ${key}`);
      for (const item of h.items) {
        if (!item || typeof item !== "object") throw new Error(`invalid Jira changelog item for ${key}`);
        const field = item.field ?? item.fieldId;
        if (typeof field !== "string" || !field.trim()) throw new Error(`invalid Jira changelog item for ${key}`);
        if (field !== "status") continue;
        if (typeof item.toString !== "string" || !item.toString.trim())
          throw new Error(`invalid Jira status history destination for ${key}`);
        // Value and timestamp come from ONE record, so they cannot drift
        // apart the way a status field and a separately-fetched timestamp can.
        out.push({ at, to: item.toString });
      }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  // Strongly-consistent membership answer for the optional jql filter, via
  // search's `reconcileIssues` parameter (verified supported on this site).
  // Throws on failure so the caller can fail CLOSED rather than fall back to
  // the stale snapshot — a silent fallback is the same mistake with extra steps.
  async scopeProbe(key: string, issueId: string): Promise<{ matches: boolean; statusName: string | null; version: string | null }> {
    const issues = await paginateJira<any>(
      `Jira scope query for ${key}`,
      null,
      async (cursor) => {
        const q = new URLSearchParams({
          jql: `(${this.jql()}) AND key = ${key}`,
          fields: "key,status,updated",
          maxResults: "100",
          reconcileIssues: issueId,
        });
        if (typeof cursor === "string") q.set("nextPageToken", cursor);
        return this.json(`/rest/api/3/search/jql?${q}`);
      },
      (body) => body?.issues
    );
    const issueKeys = issues.map((issue) => jiraIssueKey(issue, `Jira scope query for ${key}`));
    if (issueKeys.some((issueKey) => issueKey !== key))
      throw new Error(`unexpected Jira scope issue for ${key}`);
    if (issues.length > 1) throw new Error(`duplicate Jira scope issue for ${key}`);
    if (!issues.length) return { matches: false, statusName: null, version: null };
    const statusName = issues[0]?.fields?.status?.name;
    const version = issues[0]?.fields?.updated;
    if (typeof statusName !== "string" || !statusName.trim())
      throw new Error(`incomplete Jira scope status for ${key}`);
    if (!isJiraTimestamp(version))
      throw new Error(`incomplete Jira scope version for ${key}`);
    return { matches: true, statusName: statusName.trim(), version: version.trim() };
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

  // Every comment on an issue, with the `properties` expansion that carries
  // hive's idempotency key. Fails CLOSED on an incomplete page chain for the
  // same reason discover()/statusHistory() do: a truncated comment list read as
  // complete would make hive re-post comments it had already delivered.
  async comments(key: string): Promise<any[]> {
    const comments = await paginateJira<any>(
      `Jira comment history for ${key}`,
      0,
      async (cursor) => {
        const q = new URLSearchParams({
          startAt: String(cursor), maxResults: String(COMMENT_PAGE),
          orderBy: "created", expand: "properties",
        });
        return this.json(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?${q}`);
      },
      (body) => body?.comments
    );
    return comments.map((comment) => jiraComment(comment, key));
  }

  // `properties` stamps the comment with the local row id that produced it.
  async addComment(key: string, text: string, property: { key: string; id: string }): Promise<{ id: string }> {
    const posted = await this.json(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: textToAdf(text),
        properties: [{ key: property.key, value: commentPropertyCodec.encode(property.id) }],
      }),
    }, { field: "comments" });
    return { ...posted, id: jiraScalarId(posted.id, `invalid Jira comment response for ${key}`) };
  }

  async resolveTransitionId(key: string, statusName: string): Promise<string> {
    const k = encodeURIComponent(key);
    const body = await this.json(`/rest/api/3/issue/${k}/transitions`);
    const t = (body?.transitions ?? []).find((x: any) => sameStatus(String(x?.to?.name ?? ""), statusName));
    if (!t) throw new Error(`no transition to '${statusName}' available on ${key}`);
    return String(t.id);
  }

  async transition(key: string, transitionId: string): Promise<void> {
    const k = encodeURIComponent(key);
    await this.call(`/rest/api/3/issue/${k}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transitionId } }),
    }, { field: "status" });
  }

  async setLabel(key: string, label: string, present: boolean): Promise<void> {
    await this.call(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: [present ? { add: label } : { remove: label }] } }),
    }, { field: "labels", value: label });
  }

}

// ============================================================================
// THE FRESH READ
// ============================================================================
// Every per-issue action — import, pull, push, label, or comment delivery —
// derives from one of these, taken at the point of decision for that specific
// issue. Nothing reads from the batch snapshot, because there is nothing stale
// left to reach for by accident.
export interface IssueRead {
  key: string;
  issue: any;
  statusName: string;
  statusAt: number; // from the SAME record as statusName whenever one exists
  scope: "in" | "out";
  comments?: any[];
}

export interface IssueMoved {
  moved: true;
  initialStatus: string;
  finalStatus: string;
  initialVersion: string;
  finalVersion: string;
}

export interface IssueMissing {
  missing: true;
  key: string;
  httpStatus: 404;
}

export type IssueObservation = IssueRead | IssueMoved | IssueMissing;

function isIssueMissing(read: IssueObservation): read is IssueMissing {
  return "missing" in read;
}

function isIssueMoved(read: IssueObservation): read is IssueMoved {
  return "moved" in read;
}

function movedPayload(read: IssueMoved): Record<string, unknown> {
  return {
    aborted: "Jira changed during the coherent read",
    initial_status: read.initialStatus,
    final_status: read.finalStatus,
    initial_version: read.initialVersion,
    final_version: read.finalVersion,
  };
}

// Read one issue and settle its scope.
//
// Returns a typed missing observation when the issue GET returns 404 and a moved
// observation when its version changes during the read. Operational failures
// propagate so the cycle cannot report success without a trustworthy answer.
export async function readIssue(client: JiraClient, cfg: JiraConfig, key: string, includeComments = false): Promise<IssueObservation> {
  let issue: any;
  try {
    issue = await client.issue(key);
  } catch (error) {
    if (isJiraNotFound(error)) return { missing: true, key, httpStatus: 404 };
    throw error;
  }
  if (jiraIssueKey(issue, `Jira ${key}`) !== key)
    throw new Error(`unexpected Jira issue response for ${key}`);
  const issueId = jiraScalarId(issue.id, `invalid Jira issue id for ${key}`);
  validateJiraIssueFields(issue, key);

  const history = await client.statusHistory(key);

  const fieldStatus = issue.fields.status.name as string;
  const initialVersion = issue.fields.updated as string;
  const newest = history.length ? history[history.length - 1] : null;
  const created = Date.parse(issue?.fields?.created ?? "");
  const statusAt = newest?.at ?? created;
  if (!Number.isFinite(statusAt)) throw new Error(`invalid Jira status clock for ${key}`);

  const projectKey = issue.fields.project.key as string;
  const inProject = projectKey === cfg.project_key;
  const comments = includeComments && inProject ? await client.comments(key) : undefined;

  const probe = await client.scopeProbe(key, issueId);
  if ((!inProject && probe.matches) || (!cfg.jql && inProject && !probe.matches)) {
    return {
      moved: true,
      initialStatus: fieldStatus,
      finalStatus: probe.statusName ?? "",
      initialVersion,
      finalVersion: probe.version ?? "",
    };
  }
  if (
    inProject &&
    probe.matches &&
    (probe.version !== initialVersion ||
      !sameStatus(fieldStatus, newest?.to ?? fieldStatus) ||
      !sameStatus(probe.statusName ?? "", newest?.to ?? fieldStatus))
  ) {
    return {
      moved: true,
      initialStatus: fieldStatus,
      finalStatus: probe.statusName ?? "",
      initialVersion,
      finalVersion: probe.version ?? "",
    };
  }
  const scope: IssueRead["scope"] = inProject && probe.matches ? "in" : "out";

  const read: IssueRead = newest
    ? { key, issue, statusName: newest.to, statusAt, scope, comments }
    : {
        key,
        issue,
        // Never transitioned, so the field value and the creation time are
        // consistent with each other by definition.
        statusName: fieldStatus,
        statusAt,
        scope,
        comments,
      };
  return read;
}

// ============================================================================
// CONFLICT RULE
// ============================================================================
export type SyncAction = "none" | "push" | "pull";

// The whole bidirectional status decision, isolated as a pure function so the
// rule is testable without a DB or a live Jira.
//
// Agreement wins first, and it is evaluated in JIRA-STATUS SPACE. That matters:
// the hive->Jira mapping is 2:1 (in_review and verifying both mean "In Review"),
// so a hive-state comparison could never report agreement at that boundary and
// the sync would rewrite the same transition every cycle, or revert a merged
// task. Comparing the statuses the two sides actually SHOW fixes it.
//
// That single check is also what makes loop prevention structural — a
// sync-driven write leaves the sides showing the same status, so the following
// cycle decides "none" and the ping-pong never starts.
//
// Otherwise the side whose status changed more recently wins. Ties go to `pull`
// (Jira is the human-curated side, the safer default when hive cannot tell).
export function decideStatusSync(args: {
  jiraStatusName: string;
  hiveState: string;
  jiraAt: number;
  hiveAt: number | null;
}): SyncAction {
  const { jiraStatusName, hiveState, jiraAt, hiveAt } = args;
  // An unmapped Jira status (a custom column hive knows nothing about) is never
  // guessed at. The caller records the real value; here it simply means no move.
  if (jiraStatusToState(jiraStatusName) == null) return "none";
  const hiveShows = stateToJiraStatus(hiveState);
  // needs_decision rides as a LABEL, and failed/cancelled have no Jira meaning.
  // None of them may push a status, and none of them may be overwritten by Jira
  // merely for lacking an equivalent — the issue keeps the status it has.
  if (hiveShows == null) return "none";
  if (sameStatus(hiveShows, jiraStatusName)) return "none"; // agreed
  return hiveAt != null && hiveAt > jiraAt ? "push" : "pull";
}

// ============================================================================
// HIVE-SIDE WRITES
// ============================================================================
export function briefFor(issue: any, site: string): string {
  const f = issue.fields ?? {};
  return [
    `JIRA: ${site}/browse/${issue.key}`,
    `Type: ${f.issuetype?.name ?? "-"}`,
    `Priority: ${f.priority?.name ?? "-"}`,
    `Assignee: ${f.assignee?.displayName ?? f.assignee?.accountId ?? "-"}`,
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
// in_progress/in_review/verifying would emit four state_change events (and four
// manager notifications) for that one click. hive's state machine exists to
// protect ITS OWN review workflow, which is meaningless for a ticket hive never
// dispatches. Guarded to jira-linked tasks so it can never be reached for a real
// hive work item.
//
// It also deliberately does NOT expire open decisions the way transition() does
// — see the open-decision guard in reconcileIssue.
export function applyJiraState(db: DB, task: any, to: State, reason: string, jiraStatusAt: number): void {
  if (!String(task.source_ref ?? "").startsWith(REF_PREFIX)) {
    throw new Error(`refusing to force state on non-jira task ${task.id}`);
  }
  if (task.state === to) return;
  const updated = mutateWithEvent(db, () => {
    db.query("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?").run(to, now(), task.id);
    return getTask(db, task.id);
  }, {
    task_id: task.id,
    source: "jira-sync",
    type: "state_change",
    payload: { from: task.state, to, reason, jira_status_at: new Date(jiraStatusAt).toISOString() },
  });
  broadcastTask(db, updated);
}

// Every overwrite, abort, and refusal is logged with both sides and who won, so
// a "hive silently changed my ticket" complaint is always answerable after the
// fact — and so that "aborted because stale" does not look like "nothing to do".
function logSync(db: DB, taskId: string, payload: Record<string, unknown>): void {
  writeEvent(db, { task_id: taskId, source: "jira-sync", type: "jira_sync", payload });
}

// Same as logSync but suppressed when the last jira_sync event on the task
// already said exactly this. Used for conditions that persist across cycles
// (an unmapped status, an out-of-scope issue) which would otherwise write one
// event per poll forever. Mirrors noteDependencyBlock's dedupe discipline.
function logSyncOnce(db: DB, taskId: string, payload: Record<string, unknown>): void {
  // Compared against the last event of the SAME action, not simply the last
  // jira_sync event. Comment and receipt deliveries interleave with these, so a
  // plain "is this the most recent event?" check silently stopped deduping the
  // moment anything else was written in between — which is how a persistent
  // condition starts logging once per cycle again.
  const last = db
    .query(
      `SELECT payload FROM events
       WHERE task_id = ? AND type = 'jira_sync' AND json_extract(payload, '$.action') = ?
       ORDER BY ts DESC LIMIT 1`
    )
    .get(taskId, String(payload.action ?? "")) as { payload: string } | undefined;
  if (last) {
    try {
      const prev = JSON.parse(last.payload);
      if (JSON.stringify(prev) === JSON.stringify(payload)) return;
    } catch {
      /* unparseable previous event: fall through and log */
    }
  }
  logSync(db, taskId, payload);
}

// ------------------------------------------------------------------ the loop
// ---- comment + receipt bookkeeping -----------------------------------------
// hive's own idempotency key, read back off a remote comment.
function commentProperty(comment: any, key: string): string | null {
  const property = (comment?.properties ?? []).find((p: any) => p?.key === key);
  return property ? commentPropertyCodec.decode(property.value) : null;
}

// An inbound Jira comment hive has already mirrored. Checks both the timeline
// event and the sync log, so a comment hive itself pushed is never re-imported
// as though a human wrote it.
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

const receiptSourceSql = (alias: string): string =>
  `COALESCE(json_extract(${alias}.payload, '$.source_id'), json_extract(${alias}.payload, '$.event_id'))`;
const deliveredReceiptSql = (alias: string): string =>
  `(json_extract(${alias}.payload, '$.outcome') = 'ok'
    OR json_extract(${alias}.payload, '$.recovered') = 1
    OR (
      json_extract(${alias}.payload, '$.action') = 'comment_push'
      AND json_extract(${alias}.payload, '$.outcome') IS NULL
      AND json_extract(${alias}.payload, '$.event_id') IS NOT NULL
      AND json_extract(${alias}.payload, '$.jira_comment_id') IS NOT NULL
    ))`;
const settledReceiptSql = (alias: string): string =>
  `(${deliveredReceiptSql(alias)} OR json_extract(${alias}.payload, '$.outcome') IN ('rejected','resolved'))`;
const ambiguousReceiptSql = (alias: string): string =>
  `json_extract(${alias}.payload, '$.outcome') IN ('unknown','terminal_unknown')`;
const sameReceiptSql = (left: string, right: string): string =>
  `json_extract(${left}.payload, '$.action') = json_extract(${right}.payload, '$.action')
   AND ${receiptSourceSql(left)} = ${receiptSourceSql(right)}`;
const latestReceiptSql = (alias: string, later = "later"): string =>
  `NOT EXISTS (
    SELECT 1 FROM events ${later}
    WHERE ${later}.task_id = ${alias}.task_id AND ${later}.type = 'jira_sync'
      AND ${sameReceiptSql(later, alias)}
      AND ${later}.rowid > ${alias}.rowid
  )`;

// A local row (comment event or evidence row) hive has already delivered.
function deliveryRecorded(db: DB, taskId: string, action: string, sourceId: string): boolean {
  return !!db.query(
    `SELECT 1 FROM events
     WHERE task_id = ? AND type = 'jira_sync'
       AND json_extract(payload, '$.action') = ?
       AND ${receiptSourceSql("events")} = ?
       AND ${deliveredReceiptSql("events")}
       AND ${latestReceiptSql("events")} LIMIT 1`
  ).get(taskId, action, sourceId);
}

function deliveryContained(db: DB, taskId: string, action: string, sourceId: string): boolean {
  return !!db.query(
    `SELECT 1 FROM events
     WHERE task_id = ? AND type = 'jira_sync'
       AND json_extract(payload, '$.action') = ?
       AND ${receiptSourceSql("events")} = ?
       AND ${latestReceiptSql("events")}
       AND (
         ${settledReceiptSql("events")}
         OR ${ambiguousReceiptSql("events")}
         OR json_extract(events.payload, '$.outcome') = 'sending'
       ) LIMIT 1`
  ).get(taskId, action, sourceId);
}

function latestDeliveryOutcome(db: DB, taskId: string, action: string, sourceId: string): string | null {
  const row = db.query(
    `SELECT json_extract(payload, '$.outcome') AS outcome FROM events
     WHERE task_id = ? AND type = 'jira_sync'
       AND json_extract(payload, '$.action') = ?
       AND ${receiptSourceSql("events")} = ?
     ORDER BY rowid DESC LIMIT 1`
  ).get(taskId, action, sourceId) as { outcome: string | null } | undefined;
  return row?.outcome ?? null;
}

function syncEntryRecorded(db: DB, taskId: string, action: string, sourceId: string): boolean {
  return !!db.query(
    `SELECT 1 FROM events
     WHERE task_id = ? AND type = 'jira_sync'
       AND json_extract(payload, '$.action') = ?
       AND ${receiptSourceSql("events")} = ? LIMIT 1`
  ).get(taskId, action, sourceId);
}

// Where a human should click to see this in hive. Loopback by default because
// that is where hive actually serves; HIVE_PUBLIC_URL overrides it when the
// board is reachable at a stable address (Tailscale, LAN).
export function hiveBaseUrl(): string {
  return (process.env.HIVE_PUBLIC_URL || `http://127.0.0.1:${process.env.HIVE_PORT || 4700}`).replace(/\/$/, "");
}

export function resolveEvidenceUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw, `${hiveBaseUrl()}/`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---- absence streaks (intake_cursors, no new table) ----
// Only ONE kind of absence accrues a streak: absence from the SEARCH/scope
// result, which is not evidence of anything (the index lags, pages truncate).
// A direct-GET 404 is positive proof and is acted on immediately instead, so it
// never counts here. One signal, one consequence.
const SCOPE_ABSENCE_SOURCE = `${SOURCE}-scope-absent`;

function absentStreak(db: DB, key: string): string | null {
  const r = db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(SCOPE_ABSENCE_SOURCE, key) as
    | { cursor: string | null }
    | undefined;
  return r?.cursor ?? null;
}
function setAbsentStreak(db: DB, key: string, value: string): void {
  db.query(
    `INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)
     ON CONFLICT(source, key) DO UPDATE SET cursor = excluded.cursor`
  ).run(SCOPE_ABSENCE_SOURCE, key, value);
}
function clearAbsentStreak(db: DB, key: string): void {
  db.query("DELETE FROM intake_cursors WHERE source = ? AND key = ?").run(SCOPE_ABSENCE_SOURCE, key);
}

function advanceAbsence(db: DB, taskId: string, key: string): void {
  const streak = absentStreak(db, key);
  if (streak === ABSENT_STOPPED) return;
  const n = Number(streak ?? "0") + 1;
  if (n < ABSENT_STREAK_LIMIT) {
    setAbsentStreak(db, key, String(n));
    return;
  }
  const reason = `outside configured Jira scope in ${ABSENT_STREAK_LIMIT} consecutive coherent reads`;
  mutateWithEvent(db, () => setAbsentStreak(db, key, ABSENT_STOPPED), {
    task_id: taskId,
    source: "jira-sync",
    type: "jira_sync",
    payload: {
      action: "sync_stopped", issue: key, absence_kind: "scope", reason,
      note: "task left untouched; hive stopped syncing it. It resumes automatically if the issue reappears.",
    },
  });
}

// ============================================================================
// VISIBLE SYNC STATE
// ============================================================================
// A director must never have to guess whether the sync ran. Every attempt
// records its outcome, so the board can show "last synced 40s ago", "next in
// 20s", or a persistent error — and a failure stays visible until a later
// attempt actually succeeds, rather than scrolling away in a log.
//
// Stored in intake_cursors (source 'jira-state', key = project id) rather than a
// new table: it is a single per-project scalar, which is exactly what that table
// already holds for poll positions.
const STATE_SOURCE = "jira-state";

export interface JiraSyncState {
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  next_due_at: string | null;
  interval_ms: number;
  running: boolean;
  stats: SyncStats | null;
}

const BLANK_STATE: JiraSyncState = {
  last_attempt_at: null, last_success_at: null, last_error: null, last_error_at: null,
  consecutive_failures: 0, next_due_at: null, interval_ms: 0, running: false, stats: null,
};

export function readSyncState(db: DB, projectId: string): JiraSyncState {
  const r = db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(STATE_SOURCE, projectId) as
    | { cursor: string | null }
    | undefined;
  if (!r?.cursor) return { ...BLANK_STATE };
  try {
    return { ...BLANK_STATE, ...JSON.parse(r.cursor) };
  } catch {
    return { ...BLANK_STATE };
  }
}

export function writeSyncState(db: DB, projectId: string, patch: Partial<JiraSyncState>): JiraSyncState {
  const next = { ...readSyncState(db, projectId), ...patch };
  db.query(
    `INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)
     ON CONFLICT(source, key) DO UPDATE SET cursor = excluded.cursor`
  ).run(STATE_SOURCE, projectId, JSON.stringify(next));
  return next;
}

// Outbound work without a confirmed or human-resolved outcome, for one task.
// Derived rather than stored, so it cannot drift from its receipts.
export interface UnknownOutbound {
  action: "comment_push" | "receipt";
  source_id: string;
  error: string | null;
  text: string | null;
  ts: string;
}

export function pendingOutbound(db: DB, taskId: string): { comments: number; receipts: number; unknown: UnknownOutbound[] } {
  const comments = db.query(
    `SELECT COUNT(*) AS n FROM events e
     WHERE e.task_id = ? AND e.type = 'jira_comment' AND e.source != 'jira'
       AND json_extract(e.payload, '$.direction') = 'outbound'
       AND NOT EXISTS (
         SELECT 1 FROM events r WHERE r.task_id = e.task_id AND r.type = 'jira_sync'
           AND json_extract(r.payload, '$.action') = 'comment_push'
           AND ${receiptSourceSql("r")} = e.id
           AND ${settledReceiptSql("r")}
           AND ${latestReceiptSql("r")}
       )`
  ).get(taskId) as { n: number };
  const receipts = db.query(
    `SELECT COUNT(*) AS n FROM evidence v
     WHERE v.task_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM events r WHERE r.task_id = v.task_id AND r.type = 'jira_sync'
           AND json_extract(r.payload, '$.action') = 'receipt'
           AND ${receiptSourceSql("r")} = v.id
           AND ${settledReceiptSql("r")}
           AND ${latestReceiptSql("r")}
       )`
  ).get(taskId) as { n: number };
  const rows = db.query(
    `SELECT r.ts, r.payload FROM events r
     WHERE r.task_id = ? AND r.type = 'jira_sync'
       AND json_extract(r.payload, '$.action') IN ('comment_push','receipt')
       AND ${ambiguousReceiptSql("r")}
       AND ${latestReceiptSql("r")}
     ORDER BY r.rowid DESC`
  ).all(taskId) as { ts: string; payload: string }[];
  const seen = new Set<string>();
  const unknown: UnknownOutbound[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload);
    const action = payload.action;
    const sourceId = String(payload.source_id ?? payload.event_id ?? "");
    const identity = `${action}:${sourceId}`;
    if ((action !== "comment_push" && action !== "receipt") || !sourceId || seen.has(identity)) continue;
    seen.add(identity);
    unknown.push({
      action,
      source_id: sourceId,
      error: String(payload.error ?? "Jira did not confirm the request"),
      text: payload.text == null ? null : String(payload.text),
      ts: row.ts,
    });
  }
  return { comments: comments?.n ?? 0, receipts: receipts?.n ?? 0, unknown };
}

export function deliveredOutbound(db: DB, taskId: string): Record<string, unknown>[] {
  return (db.query(
    `SELECT payload FROM events
     WHERE task_id = ? AND type = 'jira_sync'
       AND json_extract(payload, '$.action') IN ('receipt','comment_push')
       AND ${deliveredReceiptSql("events")}
       AND ${latestReceiptSql("events")}
     ORDER BY ts`
  ).all(taskId) as { payload: string }[]).flatMap((row) => {
    try { return [JSON.parse(row.payload)]; } catch { return []; }
  });
}

export function resolveUnknownOutbound(db: DB, taskId: string, action: string, sourceId: string): boolean {
  const pending = pendingOutbound(db, taskId).unknown.find((row) => row.action === action && row.source_id === sourceId);
  if (!pending) return false;
  writeEvent(db, {
    task_id: taskId,
    source: "director",
    type: "jira_sync",
    payload: { action, source_id: sourceId, outcome: "resolved", resolved: true },
  });
  return true;
}

// ============================================================================
// SYNC
// ============================================================================
export interface JiraDeps {
  fetch?: FetchLike;
  exec?: Exec; // keychain resolution
  log?: (msg: string, err?: unknown) => void;
  intervalMs?: number;
  token?: string; // bypass keychain (tests)
}

export interface SyncStats {
  imported: number;
  pushed: number;
  pulled: number;
  labeled: number;
  comments_pulled: number;
  comments_pushed: number;
  receipts: number; // hive reports/evidence delivered to Jira
  shadow: number; // outbound calls suppressed by write:false
  unmapped: number; // Jira statuses hive has no mapping for
  aborted: number; // writes dropped because the boundary re-read disagreed
  blocked: number; // outbound actions refused because a prerequisite could not be confirmed
  skipped: number; // issues whose fresh read failed (missing input)
  cancelled: number; // mirrors dispositioned because their issue is proven gone
  errors: number;
  failures: string[];
}

const emptyStats = (): SyncStats => ({
  imported: 0, pushed: 0, pulled: 0, labeled: 0,
  comments_pulled: 0, comments_pushed: 0, receipts: 0,
  shadow: 0, unmapped: 0, aborted: 0, blocked: 0, skipped: 0, cancelled: 0, errors: 0, failures: [],
});

interface Ctx {
  db: DB;
  cfg: JiraConfig;
  client: JiraClient;
  stats: SyncStats;
  log: (msg: string, err?: unknown) => void;
}

function recordFailure(ctx: Ctx, message: string): void {
  ctx.stats.errors++;
  ctx.stats.failures.push(message);
}

// The shared just-before-mutation boundary. EVERY Jira write goes through here.
//
// Even with a fresh per-issue read there is a window between deciding and
// writing in which a human can move the issue. This re-reads that specific
// issue immediately before acting and re-checks the premise the decision rested
// on; if the fresh read disagrees, the write is ABORTED and both the queued and
// the fresh value are logged as a distinct, visible event.
//
// It deliberately does NOT retry in a loop. The next poll cycle re-derives the
// whole decision cleanly from fresh state — that is the entire point of a
// converging reconciler, and a retry loop would just race the human harder.
//
// This NARROWS the race; it does not eliminate it. Jira exposes no
// compare-and-swap, so a change concurrent with the in-flight mutation can
// still be overwritten. Prerequisite reads happen before this boundary; after
// the premise passes, each act performs exactly one mutation request.
async function guardedWrite<T>(
  ctx: Ctx,
  args: {
    taskId: string;
    key: string;
    entry: Record<string, unknown>;
    // Re-evaluate against the fresh read. Return null to proceed, or a reason to abort.
    premise: (fresh: IssueRead, freshTask: any) => string | ({ aborted: string } & Record<string, unknown>) | null;
    act: (fresh: IssueRead) => Promise<T>;
    success?: (result: T) => Record<string, unknown>;
    onDone: (result: T) => void;
  }
): Promise<void> {
  const { db, cfg, stats } = ctx;

  // Shadow mode: compute everything, log the intent, send nothing. Note this
  // sits BEFORE the boundary re-read — under write:false there is no write to
  // protect, and spending a network round trip to guard a no-op would be waste.
  if (!cfg.write) {
    logSync(db, args.taskId, { ...args.entry, shadow: true });
    stats.shadow++;
    return;
  }

  const fresh = await readIssue(ctx.client, cfg, args.key);
  if (isIssueMissing(fresh)) {
    logSync(db, args.taskId, { ...args.entry, aborted: "issue missing at write boundary", http_status: fresh.httpStatus });
    stats.aborted++;
    return;
  }
  if (isIssueMoved(fresh)) {
    logSync(db, args.taskId, { ...args.entry, ...movedPayload(fresh) });
    stats.aborted++;
    return;
  }
  if (fresh.scope !== "in") {
    logSync(db, args.taskId, { ...args.entry, blocked: `scope ${fresh.scope} at write boundary` });
    stats.blocked++;
    return;
  }
  const freshTask = getTask(db, args.taskId);
  if (!freshTask) {
    logSync(db, args.taskId, { ...args.entry, aborted: "hive task disappeared at write boundary", fresh_status: fresh.statusName });
    stats.aborted++;
    return;
  }
  const disagreement = args.premise(fresh, freshTask);
  if (disagreement) {
    logSync(db, args.taskId, {
      ...args.entry,
      ...(typeof disagreement === "string" ? { aborted: disagreement } : disagreement),
      fresh_status: fresh.statusName,
      fresh_hive_state: freshTask.state,
      fresh_labels: fresh.issue?.fields?.labels ?? [],
      fresh_assignee: fresh.issue?.fields?.assignee?.accountId ?? null,
    });
    stats.aborted++;
    return;
  }

  // Intent BEFORE the call, outcome after. A write Jira accepts but whose
  // response is lost is a REAL state, and recording nothing would leave that
  // overwrite invisible forever — the reconciler short-circuits once both sides
  // agree, so no later cycle would ever revisit it.
  logSync(db, args.taskId, { ...args.entry, outcome: "sending" });
  try {
    const result = await args.act(fresh);
    logSync(db, args.taskId, { ...args.entry, ...(args.success?.(result) ?? {}), outcome: "ok" });
    args.onDone(result);
  } catch (e) {
    // A 4xx proves this attempt did not mutate Jira. Only a row-specific
    // permanent rejection may settle immutable work; systemic contract failures
    // stay failed so the row retries after the client or endpoint is repaired.
    // A 5xx or transport failure cannot prove nothing happened and stays contained.
    const failure = jiraFailureKind(e);
    const immutableDelivery = args.entry.action === "comment_push" || args.entry.action === "receipt";
    if (failure === "row_rejected" && immutableDelivery) {
      logSync(db, args.taskId, { ...args.entry, outcome: "rejected", error: String(e) });
      return;
    }
    const outcome = failure === "unknown" ? "terminal_unknown" : "failed";
    logSync(db, args.taskId, { ...args.entry, outcome, error: String(e) });
    recordFailure(ctx, `${args.key} ${String(args.entry.action ?? "write")}: ${String(e instanceof Error ? e.message : e)}`);
  }
}

function titleFor(issue: any): string {
  return `[${issue.key}] ${issue.fields?.summary ?? "(no summary)"}`;
}

function hasOpenDecision(db: DB, taskId: string): boolean {
  return !!db.query("SELECT 1 FROM decisions WHERE task_id = ? AND status = 'open' LIMIT 1").get(taskId);
}

// Reconcile ONE issue. `read` is the fresh read this decision derives from;
// `task` is re-read from the DB by the caller so a decision is never applied
// against task state that moved since the batch began.
async function reconcileIssue(ctx: Ctx, read: IssueRead, task: any): Promise<void> {
  const { db, cfg, stats } = ctx;
  const key = read.key;

  // ---- reappearance: undo a deletion disposition when the issue is back.
  // The 404 the sweep acts on proves the issue is not READABLE by hive, which
  // is deletion in all but one case: Jira answers 404 rather than 403 for an
  // issue you have lost permission to see, deliberately, so it does not leak
  // existence. That makes the cancellation presumptive, and a presumptive
  // terminal state has to be reversible or a permission blip becomes a
  // permanent one-way trapdoor. Seeing the issue again is itself positive
  // evidence, so it is safe to act on. Only hive's OWN cancellation is undone:
  // a director who cancels a mirrored task means it.
  if (task.state === "cancelled" && cancelledByJiraSync(db, task.id)) {
    const back = jiraStatusToState(read.statusName) ?? "queued";
    logSync(db, task.id, { action: "source_restored", issue: key, state: back });
    applyJiraState(db, task, back, `jira ${key} exists again`, read.statusAt);
    task = getTask(db, task.id);
  }

  // ---- JIRA-owned fields always flow JIRA -> hive (hive never rewrites them)
  const title = titleFor(read.issue);
  const brief = briefFor(read.issue, cfg.site);
  if (task.title !== title || task.brief !== brief) {
    db.query("UPDATE tasks SET title = ?, brief = ?, updated_at = ? WHERE id = ?").run(title, brief, now(), task.id);
    broadcastTask(db, getTask(db, task.id));
  }

  if (!Array.isArray(read.comments)) throw new Error(`incomplete Jira comment observation for ${key}`);
  const remoteComments = importRemoteComments(ctx, key, task, read.comments);

  // ---- status: the one bidirectional field
  const jiraState = jiraStatusToState(read.statusName);
  if (jiraState == null) {
    // Never coerce an unmappable status into a valid-looking one. The old
    // `jiraState ?? "queued"` presented a custom column as a confident "queued"
    // with no record of the real value, and never self-corrected either.
    logSyncOnce(db, task.id, { action: "unmapped_status", issue: key, jira_status: read.statusName });
    stats.unmapped++;
  }

  const hiveAt = lastStateChangeAt(db, task.id);
  const action = decideStatusSync({
    jiraStatusName: read.statusName,
    hiveState: task.state,
    jiraAt: read.statusAt,
    hiveAt,
  });

  let moved = false;
  if (action === "pull") {
    // A terminal pull is irreversible for any decision still open on the task:
    // reaching done/cancelled expires open decisions, and no later cycle can
    // undo an expiry. If the pull is based on stale Jira state, that expiry is
    // permanent collateral. Refuse while a decision is open; the next cycle
    // re-derives once it is answered.
    if (TERMINAL.includes(jiraState!) && hasOpenDecision(db, task.id)) {
      logSyncOnce(db, task.id, {
        action: "pull_deferred", issue: key, reason: "open decision on task; terminal pull would expire it",
        jira_status: read.statusName, hive_state: task.state,
      });
    } else {
      applyJiraState(db, task, jiraState!, `jira ${key} -> ${read.statusName}`, read.statusAt);
      logSync(db, task.id, {
        action: "pull", issue: key, field: "status", winner: "jira",
        from: task.state, to: jiraState,
        jira_at: new Date(read.statusAt).toISOString(), hive_at: hiveAt == null ? null : new Date(hiveAt).toISOString(),
      });
      stats.pulled++;
      moved = true;
    }
  } else if (action === "push") {
    const target = stateToJiraStatus(task.state)!;
    const transitionId = cfg.write ? await ctx.client.resolveTransitionId(key, target) : undefined;
    await guardedWrite(ctx, {
      taskId: task.id, key,
      entry: {
        action: "push", issue: key, field: "status", winner: "hive",
        from: read.statusName, to: target,
        hive_state: task.state,
        jira_at: new Date(read.statusAt).toISOString(), hive_at: hiveAt == null ? null : new Date(hiveAt).toISOString(),
      },
      premise: (fresh, freshTask) => {
        const freshHiveAt = lastStateChangeAt(db, freshTask.id);
        const freshAction = decideStatusSync({
          jiraStatusName: fresh.statusName,
          hiveState: freshTask.state,
          jiraAt: fresh.statusAt,
          hiveAt: freshHiveAt,
        });
        const freshTarget = stateToJiraStatus(freshTask.state);
        return freshAction === "push" && sameStatus(freshTarget, target)
          ? null
          : {
              aborted: "status decision changed since the decision",
              fresh_jira_at: new Date(fresh.statusAt).toISOString(),
              fresh_hive_at: freshHiveAt == null ? null : new Date(freshHiveAt).toISOString(),
              fresh_action: freshAction,
              fresh_target: freshTarget,
            };
      },
      act: (fresh) => ctx.client.transition(fresh.key, transitionId!),
      onDone: () => { stats.pushed++; moved = true; },
    });
  }

  // Everything below reads state fetched AFTER the status step, never the
  // pre-pull snapshot: a pull may have just changed the hive state, and a push
  // may have just changed the Jira one.
  const current = getTask(db, task.id) ?? task;
  let after = read;
  if (moved) {
    const re = await readIssue(ctx.client, cfg, key);
    if (isIssueMissing(re)) {
      stats.skipped++;
      return; // cannot see the post-write truth; label and comment reconciliation wait for next cycle
    }
    if (isIssueMoved(re)) {
      logSync(db, task.id, { action: "read_aborted", issue: key, ...movedPayload(re) });
      stats.skipped++;
      return;
    }
    if (re.scope !== "in") {
      logSyncOnce(db, task.id, { action: "out_of_scope", issue: key, scope: re.scope });
      return;
    }
    after = re;
  }

  // ---- needs_decision rides as a label, since Jira has no such status
  const wantLabel = current.state === "needs_decision";
  const labels: string[] = after.issue?.fields?.labels ?? [];
  if (wantLabel !== labels.includes(NEEDS_DECISION_LABEL)) {
    await guardedWrite(ctx, {
      taskId: task.id, key,
      entry: { action: "label", issue: key, label: NEEDS_DECISION_LABEL, present: wantLabel },
      premise: (fresh, freshTask) => {
        if ((freshTask.state === "needs_decision") !== wantLabel) return "hive task state changed since the label decision";
        return (fresh.issue?.fields?.labels ?? []).includes(NEEDS_DECISION_LABEL) === wantLabel
          ? "label already in the desired state"
          : null;
      },
      act: (fresh) => ctx.client.setLabel(fresh.key, NEEDS_DECISION_LABEL, wantLabel),
      onDone: () => { stats.labeled++; },
    });
  }

  // ---- assignee is DELIBERATELY not synced.
  //
  // hive used to place its own account on an issue as a "someone is on this"
  // marker. The director removed that (dec_234877ea4617, answered "disable"):
  // the check and the write are two separate requests and Jira Cloud has no
  // compare-and-swap, so a human assigning themselves in the gap could be
  // overwritten. The guarantee "a human's assignment is never touched" only
  // holds absolutely if hive never writes the field at all, so it does not.
  // hive still READS the assignee, to show it on the board.

  // ---- comments and receipts: everything hive says to Jira, with remote keys
  await syncCommentsAndReceipts(ctx, key, current, remoteComments);
}

// One pass over the issue's comments, covering all three directions of text:
// inbound human comments, outbound hive comments, and hive's own reports and
// evidence delivered as receipts.
//
// Every comment hive writes carries a Jira comment PROPERTY naming the local
// row that produced it. A later cycle recovers a missing receipt when that
// property is visible. Because Jira does not make the property unique, an
// unconfirmed request remains visible for human confirmation instead of being
// retried into the real late-arrival duplication window.
function importRemoteComments(ctx: Ctx, key: string, task: any, remote: any[]): {
  sentComments: Map<string, string>;
  sentReceipts: Map<string, string>;
} {
  const { db, stats } = ctx;
  const sentComments = new Map<string, string>();
  const sentReceipts = new Map<string, string>();
  for (const c of remote) {
    const eventId = commentProperty(c, HIVE_COMMENT_PROPERTY);
    if (eventId) { sentComments.set(eventId, String(c.id)); continue; }
    const evidenceId = commentProperty(c, HIVE_EVIDENCE_PROPERTY);
    if (evidenceId) { sentReceipts.set(evidenceId, String(c.id)); continue; }

    // ---- inbound: a human's Jira comment becomes a hive timeline entry.
    // Anything carrying one of hive's properties was skipped above, so hive
    // never re-imports its own writing as though a person wrote it.
    const jiraId = String(c.id ?? "");
    if (!jiraId || jiraCommentRecorded(db, task.id, jiraId)) continue;
    writeEvent(db, {
      task_id: task.id,
      source: "jira",
      type: "jira_comment",
      payload: {
        direction: "inbound", jira_id: jiraId, issue: key,
        author: c.author?.displayName ?? c.author?.accountId ?? "Jira",
        text: adfToText(c.body).trim(),
        created: c.created ?? null,
      },
    });
    stats.comments_pulled++;
  }
  return { sentComments, sentReceipts };
}

async function syncCommentsAndReceipts(
  ctx: Ctx,
  key: string,
  task: any,
  remote: { sentComments: Map<string, string>; sentReceipts: Map<string, string> }
): Promise<void> {
  const { db, cfg, stats } = ctx;
  const { sentComments, sentReceipts } = remote;

  // ---- outbound: hive-side comments queued for Jira
  const pending = db.query(
    `SELECT id, payload FROM events
     WHERE task_id = ? AND type = 'jira_comment' AND source != 'jira'
       AND json_extract(payload, '$.direction') = 'outbound'
     ORDER BY ts`
  ).all(task.id) as { id: string; payload: string }[];
  for (const ev of pending) {
    if (deliveryRecorded(db, task.id, "comment_push", ev.id)) continue;
    const recovered = sentComments.get(ev.id);
    if (recovered) {
      // Posted before a crash swallowed the receipt. Record it now; do NOT re-post.
      logSync(db, task.id, { action: "comment_push", issue: key, source_id: ev.id, jira_comment_id: recovered, outcome: "recovered", recovered: true });
      continue;
    }
    if (latestDeliveryOutcome(db, task.id, "comment_push", ev.id) === "sending") {
      logSync(db, task.id, {
        action: "comment_push", issue: key, source_id: ev.id,
        outcome: "terminal_unknown", error: "Hive stopped before Jira confirmed the request",
      });
      continue;
    }
    if (deliveryContained(db, task.id, "comment_push", ev.id)) continue;
    const text = String(JSON.parse(ev.payload)?.text ?? "").trim();
    if (!text) {
      logSync(db, task.id, { action: "comment_push", issue: key, source_id: ev.id, outcome: "rejected", error: "empty outbound Jira comment" });
      continue;
    }
    if (text.length > JIRA_COMMENT_MAX_LENGTH) {
      logSync(db, task.id, {
        action: "comment_push", issue: key, source_id: ev.id, outcome: "rejected",
        error: `outbound Jira comment exceeds the ${JIRA_COMMENT_MAX_LENGTH}-character limit`,
      });
      continue;
    }
    const action = cfg.write ? "comment_push" : "comment_shadow";
    if (!cfg.write && syncEntryRecorded(db, task.id, action, ev.id)) continue;
    await guardedWrite(ctx, {
      taskId: task.id,
      key,
      entry: { action, issue: key, source_id: ev.id, text },
      premise: () => null,
      act: (fresh) => ctx.client.addComment(fresh.key, text, { key: HIVE_COMMENT_PROPERTY, id: ev.id }),
      success: (posted) => ({ jira_comment_id: posted.id }),
      onDone: () => { stats.comments_pushed++; },
    });
  }

  // ---- receipts: hive's own reports and evidence, keyed per artifact.
  // A director reading the Jira ticket should not have to go find out whether
  // hive produced anything; the ticket says so, with links back.
  const evidence = db.query(
    "SELECT id, ts, kind, url, caption FROM evidence WHERE task_id = ? ORDER BY ts"
  ).all(task.id) as { id: string; ts: string; kind: string; url: string | null; caption: string | null }[];
  for (const row of evidence) {
    if (deliveryRecorded(db, task.id, "receipt", row.id)) continue;
    const recovered = sentReceipts.get(row.id);
    if (recovered) {
      logSync(db, task.id, { action: "receipt", issue: key, source_id: row.id, jira_comment_id: recovered, outcome: "recovered", recovered: true });
      continue;
    }
    if (latestDeliveryOutcome(db, task.id, "receipt", row.id) === "sending") {
      logSync(db, task.id, {
        action: "receipt", issue: key, source_id: row.id,
        outcome: "terminal_unknown", error: "Hive stopped before Jira confirmed the request",
      });
      continue;
    }
    if (deliveryContained(db, task.id, "receipt", row.id)) continue;
    const text = receiptText(task, row);
    const action = cfg.write ? "receipt" : "receipt_shadow";
    if (!cfg.write && syncEntryRecorded(db, task.id, action, row.id)) continue;
    await guardedWrite(ctx, {
      taskId: task.id,
      key,
      entry: { action, issue: key, source_id: row.id, text },
      premise: () => null,
      act: (fresh) => ctx.client.addComment(fresh.key, text, { key: HIVE_EVIDENCE_PROPERTY, id: row.id }),
      success: (posted) => ({ jira_comment_id: posted.id }),
      onDone: () => { stats.receipts++; },
    });
  }
}

// What a receipt says on the Jira ticket. Written for a human reading Jira with
// no hive context: what it is, what produced it, and where to click.
export function receiptText(
  task: { id: string; number?: number; title?: string; state?: string },
  row: { kind: string; url: string | null; caption: string | null; ts: string }
): string {
  const base = hiveBaseUrl();
  const label = row.kind === "report" ? "report" : row.kind;
  const directLink = resolveEvidenceUrl(row.url);
  const hiveLink = `${base}/tasks/${task.id}`;
  const receipt = [
    `Hive attached a ${label}: ${row.caption?.trim() || "(no caption)"}`,
    "",
    `Task: #${task.number ?? "?"} ${task.title ?? ""} (${task.state ?? "?"})`,
    `Open in Hive: ${hiveLink}`,
    ...(directLink ? [`Direct link: ${directLink}`] : []),
    `Recorded: ${row.ts}`,
  ].join("\n");
  if (receipt.length <= JIRA_COMMENT_MAX_LENGTH) return receipt;
  return [
    "Hive attached evidence. Caption and direct link omitted because the receipt exceeded Jira's limit.",
    "",
    `Open in Hive: ${hiveLink}`,
  ].join("\n");
}

// Import an issue hive has never seen, then reconcile it ON THE SAME CYCLE.
//
// A new import reconciles status, the reserved label, and comments in the same
// cycle, including the first shadow-mode pass.
async function importAndReconcile(ctx: Ctx, projectId: string, read: IssueRead): Promise<void> {
  const { db, cfg, stats } = ctx;
  if (read.scope !== "in" || !Array.isArray(read.comments))
    throw new Error(`incomplete Jira import observation for ${read.key}`);
  const ref = REF_PREFIX + read.key;
  const jiraState = jiraStatusToState(read.statusName);
  const id = newId();
  const t = now();
  const task = mutateWithEvent(db, () => {
    db.query(
      `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at)
       VALUES (?,?,?,?,?, 'ship', 'external', ?, ?, ?)`
    ).run(id, projectId, titleFor(read.issue), briefFor(read.issue, cfg.site), jiraState ?? "queued", ref, t, t);
    return getTask(db, id);
  }, {
    task_id: id,
    source: "jira-sync",
    type: "jira_sync",
    payload: {
      action: "import", issue: read.key, jira_status: read.statusName,
      jira_status_at: new Date(read.statusAt).toISOString(),
      state: jiraState ?? "queued",
      // An unmapped status still has to become SOME hive state. Record the
      // coercion and the original value rather than presenting the guess as fact.
      ...(jiraState == null ? { unmapped: true, coerced_to: "queued" } : {}),
    },
  });
  broadcastTask(db, task);
  stats.imported++;

  await reconcileIssue(ctx, read, task);
}

function jiraTargetKey(cfg: JiraConfig): string {
  return `${new URL(cfg.site).host}/${cfg.project_key}`;
}

function jiraTargetOwner(db: DB, projectId: string, cfg: JiraConfig): string {
  const linkedOwners = db.query(
    "SELECT project_id FROM tasks WHERE source_ref LIKE ? GROUP BY project_id ORDER BY MIN(created_at), project_id"
  ).all(`${REF_PREFIX}${cfg.project_key}-%`) as { project_id: string }[];
  if (linkedOwners.length > 1)
    throw new Error(`jira target ${jiraTargetKey(cfg)} already has linked tasks in multiple Hive projects`);
  if (linkedOwners.length === 1) return linkedOwners[0].project_id;

  const projects = db.query("SELECT id, config FROM projects ORDER BY created_at, id").all() as { id: string; config: string }[];
  for (const project of projects) {
    try {
      const candidate = jiraConfig(JSON.parse(project.config || "{}"));
      if (candidate && jiraTargetKey(candidate) === jiraTargetKey(cfg)) return project.id;
    } catch {}
  }
  return projectId;
}

function assertJiraTargetOwner(db: DB, projectId: string, cfg: JiraConfig): void {
  const owner = jiraTargetOwner(db, projectId, cfg);
  if (owner !== projectId)
    throw new Error(`jira target ${jiraTargetKey(cfg)} is owned by Hive project ${owner}; refusing project ${projectId}`);
}

export async function syncProjectOnce(
  db: DB,
  projectId: string,
  cfg: JiraConfig,
  client: JiraClient,
  deps: JiraDeps = {}
): Promise<SyncStats> {
  assertJiraTargetOwner(db, projectId, cfg);
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[hive] jira: ${m}`, e ?? ""));
  const ctx: Ctx = { db, cfg, client, stats: emptyStats(), log };

  // Discovery must succeed before any verified absence can advance: a failed
  // scope check is not evidence that anything went missing.
  const discovered = await client.discover();
  const linked = db
    .query("SELECT id, source_ref FROM tasks WHERE project_id = ? AND source_ref LIKE ?")
    .all(projectId, REF_PREFIX + "%") as { id: string; source_ref: string }[];
  const linkedByKey = new Map(linked.map((row) => [row.source_ref.slice(REF_PREFIX.length), row]));
  const keys = [...new Set([...discovered, ...linkedByKey.keys()])];

  for (const key of keys) {
    let read: IssueObservation;
    try {
      read = await readIssue(client, cfg, key, true);
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
      recordFailure(ctx, `${key}: ${message}`);
      log(`issue ${key} failed`, e);
      continue;
    }
    const linkedTask = linkedByKey.get(key);
    if (isIssueMissing(read)) {
      // A direct per-issue GET answering 404 is POSITIVE proof, which is a
      // different fact from "search did not return it" (that only nominates a
      // candidate, handled by the scope branch below and never destructive).
      // So this needs no streak: one proven 404 is the evidence, and a 5xx or
      // timeout never reaches here because readIssue propagates it.
      //
      // The row is never deleted: its comments, evidence and receipts are the
      // only surviving record that the work existed. `cancelled` is terminal,
      // so the mirror drops off the board and out of the attention tray.
      //
      // Reversible on purpose. Jira answers 404 rather than 403 for an issue
      // you have lost permission to see, so the proof is of unreadability, not
      // strictly of deletion, and a presumptive terminal state must not be a
      // one-way trapdoor. See the reappearance branch in reconcileIssue.
      clearAbsentStreak(db, key);
      if (!linkedTask) {
        ctx.stats.skipped++;
        continue;
      }
      const linkedState = (getTask(db, linkedTask.id) as any)?.state;
      if (!TERMINAL.includes(linkedState as State)) {
        logSync(db, linkedTask.id, { action: "source_deleted", issue: key, proof: "direct GET returned 404" });
        transition(db, linkedTask.id, "cancelled", {
          source: "jira-sync",
          reason: `jira ${key} no longer exists (direct read returned 404)`,
        });
        ctx.stats.cancelled++;
      }
      continue;
    }
    if (isIssueMoved(read) || read.scope === "in") clearAbsentStreak(db, key);
    if (isIssueMoved(read)) {
      if (linkedTask) logSync(db, linkedTask.id, { action: "read_aborted", issue: key, ...movedPayload(read) });
      ctx.stats.skipped++;
      continue;
    }
    if (read.scope !== "in") {
      if (!linkedTask) {
        ctx.stats.skipped++;
        continue;
      }
      logSyncOnce(db, linkedTask.id, { action: "out_of_scope", issue: key, scope: read.scope });
      advanceAbsence(db, linkedTask.id, key);
      continue;
    }

    try {
      const task = db.query("SELECT * FROM tasks WHERE project_id = ? AND source_ref = ?").get(projectId, REF_PREFIX + key) as any;
      if (!task) await importAndReconcile(ctx, projectId, read);
      else await reconcileIssue(ctx, read, task);
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
      recordFailure(ctx, `${key}: ${message}`);
      log(`issue ${key} failed`, e);
    }
  }

  return ctx.stats;
}

// The interval the poll loop uses. Shared so the reported "next sync" and the
// timer that actually fires cannot disagree.
export function jiraIntervalMs(deps: JiraDeps = {}): number {
  return deps.intervalMs ?? Number(process.env.HIVE_JIRA_SYNC_MS || 60_000);
}

export function jiraConfigStatusFor(db: DB, projectId: string): JiraConfigStatus {
  const row = db.query("SELECT config FROM projects WHERE id = ?").get(projectId) as { config: string } | undefined;
  if (!row) return { config: null, error: null };
  try {
    return jiraConfigStatus(JSON.parse(row.config || "{}"));
  } catch {
    return { config: null, error: "project config is not valid JSON" };
  }
}

// Read one project's Jira config, gate included. Exported so the API can tell
// "not configured" from "configured but pointing somewhere not allowed".
export function jiraConfigFor(db: DB, projectId: string): JiraConfig | null {
  return jiraConfigStatusFor(db, projectId).config;
}

// ONE cycle for ONE project, wrapped in visible state.
//
// This is the single path for both the automatic timer and the manual retry
// button, so a director who clicks retry exercises exactly what the timer does —
// no second code path that could succeed while the real one fails.
const activeTargetCycles = new WeakMap<object, Set<string>>();

export async function runProjectCycle(
  db: DB,
  projectId: string,
  deps: JiraDeps = {}
): Promise<{ ok: boolean; stats?: SyncStats; error?: string; state: JiraSyncState }> {
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[hive] jira: ${m}`, e ?? ""));
  const interval = jiraIntervalMs(deps);
  const startedAt = now();
  const fail = (error: string, stats?: SyncStats) => {
    const prev = readSyncState(db, projectId);
    const state = writeSyncState(db, projectId, {
      last_attempt_at: startedAt, last_error: error, last_error_at: now(),
      consecutive_failures: prev.consecutive_failures + 1,
      interval_ms: interval, running: false, ...(stats ? { stats } : {}),
    });
    return { ok: false, error, ...(stats ? { stats } : {}), state };
  };

  const configStatus = jiraConfigStatusFor(db, projectId);
  if (configStatus.error) return fail(`jira cycle could not run: ${configStatus.error}`);
  const cfg = configStatus.config;
  if (!cfg) return fail("jira cycle could not run: config missing, or its site/email/project is not the allow-listed target");
  if (!cfg.enabled) return fail("jira cycle could not run: sync is disabled for this project (config.jira.enabled is false)");

  const target = jiraTargetKey(cfg);
  let active = activeTargetCycles.get(db as object);
  if (!active) {
    active = new Set();
    activeTargetCycles.set(db as object, active);
  }
  if (active.has(target)) {
    const error = `jira sync cycle already running for target ${target}`;
    log(`previous cycle still running for target ${target}; skipping this tick`);
    return { ok: false, error, state: readSyncState(db, projectId) };
  }
  active.add(target);

  try {
    if (isOffline(db)) return fail("jira cycle could not run: hive is in offline mode; network-backed sync is paused");

    writeSyncState(db, projectId, { last_attempt_at: startedAt, running: true, interval_ms: interval });
    const token = deps.token ?? (await resolveProjectSecrets(db, projectId, deps.exec ?? defaultExec)).JIRA_API_TOKEN;
    if (!token) return fail("jira cycle could not run: JIRA_API_TOKEN is not resolvable from the keychain for this project");
    const client = new JiraClient(cfg, token, deps.fetch ?? fetch);
    const stats = await syncProjectOnce(db, projectId, cfg, client, deps);
    if (stats.errors > 0) {
      const detail = stats.failures.length ? `: ${stats.failures.join("; ")}` : "";
      return fail(`jira cycle completed with ${stats.errors} issue failure${stats.errors === 1 ? "" : "s"}${detail}`, stats);
    }
    const state = writeSyncState(db, projectId, {
      last_success_at: now(), last_error: null, last_error_at: null,
      consecutive_failures: 0, interval_ms: interval, running: false, stats,
    });
    const touched =
      stats.imported || stats.pushed || stats.pulled || stats.labeled || stats.comments_pulled ||
      stats.comments_pushed || stats.receipts || stats.shadow || stats.unmapped || stats.aborted ||
      stats.blocked || stats.skipped || stats.errors;
    if (touched)
      console.log(
        `[hive] jira ${cfg.project_key}${cfg.write ? "" : " (shadow)"}: ` +
          `+${stats.imported} imported, ${stats.pushed} pushed, ${stats.pulled} pulled, ${stats.labeled} labeled, ` +
          `${stats.comments_pulled} comments in, ${stats.comments_pushed} comments out, ${stats.receipts} receipts, ` +
          `${stats.shadow} shadow, ${stats.unmapped} unmapped, ${stats.aborted} aborted, ${stats.blocked} blocked, ` +
          `${stats.skipped} skipped, ${stats.errors} errors`
      );
    return { ok: true, stats, state };
  } catch (e) {
    log(`project ${projectId} sync failed`, e);
    return fail(`jira cycle could not run: ${String(e instanceof Error ? e.message : e)}`);
  } finally {
    active.delete(target);
    if (active.size === 0) activeTargetCycles.delete(db as object);
  }
}

// One cycle across every project that opted in. Hard no-op when none have.
export async function syncJiraOnce(db: DB, deps: JiraDeps = {}): Promise<SyncStats[]> {
  const out: SyncStats[] = [];
  if (isOffline(db)) return out;
  const projects = db.query("SELECT id FROM projects").all() as { id: string }[];
  for (const p of projects) {
    const status = jiraConfigStatusFor(db, p.id);
    if (!status.error && !status.config?.enabled) continue;
    const r = await runProjectCycle(db, p.id, deps);
    if (r.stats) out.push(r.stats);
  }
  return out;
}

export function startJiraSync(db: DB, deps: JiraDeps = {}): () => void {
  const intervalMs = jiraIntervalMs(deps);
  let nextFireAt = Date.now() + intervalMs;
  const publishNextDue = (value: string | null) => {
    const projects = db.query("SELECT id, config FROM projects").all() as { id: string; config: string }[];
    for (const project of projects) {
      try {
        if (jiraConfig(JSON.parse(project.config || "{}"))?.enabled)
          writeSyncState(db, project.id, { next_due_at: value, interval_ms: intervalMs });
      } catch {}
    }
  };
  publishNextDue(new Date(nextFireAt).toISOString());
  const timer = setInterval(() => {
    nextFireAt += intervalMs;
    while (nextFireAt <= Date.now()) nextFireAt += intervalMs;
    publishNextDue(new Date(nextFireAt).toISOString());
    syncJiraOnce(db, deps)
      .catch((e) => console.error("[hive] jira sync crashed:", e));
  }, intervalMs);
  return () => {
    clearInterval(timer);
    publishNextDue(null);
  };
}
