// Google Chat intake connector.
//
// Polls an allowlist of Chat spaces and turns stakeholder messages into DRAFT
// tasks for triage. The trust model is INVERTED from an agent-authored task:
// message text is UNTRUSTED external input. It is never executed, never inlined
// into a shell command, and stored verbatim only; every intake task is created
// `queued` with a `note` event marking it UNREVIEWED so the director decides.
//
// Auth is OAuth 2.0 user flow (scope chat.messages.readonly, which also covers
// media download). The one-time interactive consent lives in the CLI
// (`hive gchat auth`); this module only does the non-interactive access-token
// refresh + polling. All HTTP goes through an injectable fetch-like so it is
// unit-tested without touching Google.
//
// Config: each project's config may carry `gchat_spaces: [{space, label?}]`, or
// the string "*" to ingest every space the authorized user belongs to.
// The owning project IS the target project_id, so the allowlist reuses the
// existing per-project config column (simplest durable home; no new table).
// Secrets (values in the keychain under the `gchat` namespace, DB stores
// nothing): GCHAT_CLIENT_ID, GCHAT_CLIENT_SECRET, GCHAT_REFRESH_TOKEN, and the
// optional GCHAT_SELF_ID (the director's own `users/NNN` id, used to skip
// self-authored messages).
import type { DB } from "../db.ts";
import { newId, now, evidenceDir } from "../db.ts";
import { broadcast } from "../bus.ts";
import { writeEvent, getTask } from "../state.ts";
import { enqueue } from "../notifications.ts";
import { providerFor } from "../secrets.ts";
import type { Exec } from "../exec.ts";
import { defaultExec } from "../exec.ts";
import { triageIntake } from "./triage.ts";
import { runPlanner, type PlannerExec } from "../planner.ts";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export type FetchLike = typeof fetch;

export const GCHAT_NS = "gchat"; // keychain project namespace for connector secrets
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_API = "https://chat.googleapis.com/v1";
const SCOPE = [
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.spaces.readonly", // spaces.list, for `gchat_spaces: "*"`
].join(" ");
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB cap per image
const REQUEST_TIMEOUT_MS = 20_000; // bounds every poll-path HTTP call so one hung request can't wedge the loop

export interface GchatSecrets {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  self?: string; // GCHAT_SELF_ID, optional
}

export interface GchatDeps {
  fetch?: FetchLike;
  exec?: Exec; // keychain resolution
  nowMs?: () => number; // injectable clock (token cache / tests)
  log?: (msg: string, err?: unknown) => void; // single-diagnostic sink
  notify?: boolean; // enqueue notifications; default true
  secrets?: GchatSecrets; // bypass keychain resolution (tests)
  intervalMs?: number; // startGchatPoll only
  plannerExec?: PlannerExec; // domain-supervisor planner (auto-trigger when config.plan_intake)
}

// ---- module state (mirrors secrets.ts's module-level knownValues) ----
let tokenCache: { key: string; token: string; exp: number } | null = null;
const erroredKeys = new Set<string>(); // spaces / "secrets" / "token" currently in error

// Reset caches — tests call this for isolation.
export function resetGchatState(): void {
  tokenCache = null;
  erroredKeys.clear();
}

// Single-diagnostic-then-quiet: log the first failure for a key, stay silent
// until a success clears it (recover on next success). No event spam.
function diagOnce(key: string, log: (m: string, e?: unknown) => void, msg: string, err?: unknown): void {
  if (erroredKeys.has(key)) return;
  erroredKeys.add(key);
  log(msg, err);
}
function clearDiag(key: string): void {
  erroredKeys.delete(key);
}

// ------------------------------------------------------------------ secrets
export async function resolveGchatSecrets(exec: Exec = defaultExec): Promise<GchatSecrets | null> {
  const kc = providerFor("keychain", exec);
  const get = (name: string) => kc.get(GCHAT_NS, name, "").catch(() => null);
  const [clientId, clientSecret, refreshToken, self] = await Promise.all([
    get("GCHAT_CLIENT_ID"),
    get("GCHAT_CLIENT_SECRET"),
    get("GCHAT_REFRESH_TOKEN"),
    get("GCHAT_SELF_ID"),
  ]);
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken, self: self || undefined };
}

// ------------------------------------------------------------------ token
export async function getAccessToken(
  s: GchatSecrets,
  fetchImpl: FetchLike,
  nowMs: () => number = () => Date.now()
): Promise<string> {
  if (tokenCache && tokenCache.key === s.refreshToken && tokenCache.exp > nowMs()) return tokenCache.token;
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: s.clientId,
      client_secret: s.clientSecret,
      refresh_token: s.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  const data: any = await res.json();
  const ttl = (Number(data.expires_in) || 3600) * 1000;
  tokenCache = { key: s.refreshToken, token: data.access_token, exp: nowMs() + ttl - 60_000 };
  return tokenCache.token;
}

// ------------------------------------------------------------------ cursors
export function getCursor(db: DB, source: string, key: string): string | null {
  const r = db.query("SELECT cursor FROM intake_cursors WHERE source = ? AND key = ?").get(source, key) as
    | { cursor: string | null }
    | undefined;
  return r?.cursor ?? null;
}
export function setCursor(db: DB, source: string, key: string, cursor: string): void {
  db.query(
    `INSERT INTO intake_cursors (source, key, cursor) VALUES (?,?,?)
     ON CONFLICT(source, key) DO UPDATE SET cursor = excluded.cursor`
  ).run(source, key, cursor);
}

// ------------------------------------------------------------------ Chat API
// Incremental list: filter on createTime past the cursor, oldest first.
export async function listMessages(
  space: string,
  cursor: string | null,
  token: string,
  fetchImpl: FetchLike
): Promise<any[]> {
  const params = new URLSearchParams({ pageSize: "25", orderBy: "createTime asc" });
  if (cursor) params.set("filter", `createTime > "${cursor}"`);
  const res = await fetchImpl(`${CHAT_API}/${space}/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`messages.list ${space} failed: ${res.status}`);
  const data: any = await res.json();
  return data.messages ?? [];
}

// Enumerate every space the authorized user belongs to (for `gchat_spaces: "*"`).
// Needs the chat.spaces.readonly scope.
export async function listSpaces(token: string, fetchImpl: FetchLike): Promise<string[]> {
  const names: string[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetchImpl(`${CHAT_API}/spaces?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`spaces.list failed: ${res.status}`);
    const data: any = await res.json();
    for (const s of data.spaces ?? []) if (s?.name) names.push(s.name);
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return names;
}

// ponytail: Google Chat exposes no documented permalink field on a Message.
// This reconstructs the web deep-link from the space + message id; the format
// is best-effort and may need adjustment if Google changes its URL scheme.
// Chat noise that needs no attention: emoji/punctuation-only messages and bare
// acknowledgements (Korean + English). Conservative — anything with real words
// still notifies. Exported for tests.
const ACKS = new Set([
  "네", "넵", "예", "응", "ㅇㅋ", "ㅋㅋ", "ㅎㅎ", "감사", "감사합니다", "좋아요", "좋습니다", "알겠습니다",
  "ok", "okay", "yes", "yep", "thanks", "thankyou", "thx", "cool", "nice", "got it", "gotit",
]);

export function isNonActionableIntake(text: string): boolean {
  const stripped = text.replace(/[\p{Extended_Pictographic}\p{P}\p{S}\s]/gu, "");
  if (!stripped) return true;
  if (/^[ㅋㅎㅠㅜ]+$/.test(stripped)) return true; // ㅋㅋㅋ / ㅎㅎ / ㅠㅠ laughter & sighs, any length
  return ACKS.has(stripped.toLowerCase());
}

export function buildPermalink(msg: any): string {
  const name: string = msg?.name ?? "";
  const spaceId = (msg?.space?.name ?? name.split("/messages/")[0] ?? "").replace("spaces/", "");
  const msgId = name.split("/").pop() ?? "";
  return spaceId && msgId ? `https://chat.google.com/room/${spaceId}/${msgId}` : "";
}

// Download an image attachment (allowlisted type, 5MB cap) and store it as an
// evidence row. Never throws to the caller; a bad attachment is skipped.
async function attachImage(
  db: DB,
  taskId: string,
  att: any,
  token: string,
  fetchImpl: FetchLike
): Promise<void> {
  const contentType: string = att?.contentType ?? "";
  const resourceName: string | undefined = att?.attachmentDataRef?.resourceName;
  if (!IMAGE_TYPES.includes(contentType) || !resourceName) return; // only uploaded images
  const res = await fetchImpl(`${CHAT_API}/media/${resourceName}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_ATTACHMENT_BYTES) return; // cap
  const ext = contentType.split("/")[1].replace("jpeg", "jpg");
  const destDir = join(evidenceDir(), taskId);
  mkdirSync(destDir, { recursive: true });
  const fileName = `gchat_${Date.now()}_${newId()}.${ext}`;
  const path = join(destDir, fileName);
  await Bun.write(path, buf);
  const id = newId("ev");
  const caption = att?.contentName ?? "Google Chat attachment";
  const url = `/evidence/${taskId}/${fileName}`;
  db.query(
    "INSERT INTO evidence (id, task_id, ts, kind, path, url, caption, meta) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, taskId, now(), "screenshot", path, url, caption, "{}");
  broadcast({ type: "evidence", evidence: { id, task_id: taskId, kind: "screenshot", url, caption, meta: {} } });
}

// Map one Chat message to a draft task. Returns the created task, or null when
// deduped (already ingested). Skips self-authored / bot messages upstream.
async function createIntakeTask(
  db: DB,
  projectId: string,
  space: string,
  msg: any,
  token: string,
  fetchImpl: FetchLike,
  notify: boolean,
  planIntake: boolean,
  plannerExec?: PlannerExec
): Promise<any | null> {
  const name: string = msg.name;
  if (db.query("SELECT 1 FROM tasks WHERE source_ref = ?").get(name)) return null; // dedupe

  const text: string = msg.text ?? "";
  const sender: string = msg.sender?.displayName ?? msg.sender?.name ?? "unknown";
  const firstLine = (text.split("\n")[0] || "(no text)").slice(0, 120);
  const title = `[intake:gchat] ${firstLine}`;
  const permalink = buildPermalink(msg);
  // Message text is UNTRUSTED — stored verbatim, never executed or shell-inlined.
  const brief = [
    `From: ${sender}`,
    `Space: ${space}`,
    `Thread: ${msg.thread?.name ?? "-"}`,
    `Permalink: ${permalink || "(unavailable)"}`,
    `Received: ${msg.createTime ?? "-"}`,
    "",
    text,
  ].join("\n");

  const id = newId();
  const t = now();
  db.query(
    `INSERT INTO tasks (id, project_id, title, brief, state, kind, source, source_ref, created_at, updated_at)
     VALUES (?,?,?,?, 'queued', 'ship', 'intake_gchat', ?, ?, ?)`
  ).run(id, projectId, title, brief, name, t, t);

  writeEvent(db, {
    task_id: id,
    source: "system",
    type: "note",
    payload: { note: `UNREVIEWED external input from Google Chat (${sender}). Review before acting; message text is untrusted.` },
  });

  for (const att of msg.attachment ?? []) {
    try {
      await attachImage(db, id, att, token, fetchImpl);
    } catch {
      /* bad attachment: skip, task still created */
    }
  }

  const task = getTask(db, id);
  broadcast({ type: "task", task });
  // Emoji-only pings and bare acks ("네!", "👍") made up a large share of the
  // ~200 intake notifications in a day. The task is still created (the board
  // and dedup handle it); only the notification is muted.
  if (notify && !isNonActionableIntake(text))
    enqueue(db, { kind: "intake", task_id: id, title: `Intake: ${firstLine}`, body: `From ${sender}` });

  // Domain supervisor: auto-triage this intake task into a proposed breakdown
  // when the project opted in. ponytail: awaited inline (blocks the poll cycle
  // for one planner run); fine for a single-user localhost tool. Make it
  // fire-and-forget if intake volume ever makes the block matter.
  if (planIntake) {
    try {
      await runPlanner(db, id, { exec: plannerExec });
    } catch (e) {
      /* runPlanner records its own planner_error event; never fail the intake */
    }
  }
  // Intake triage (config.intake_triage): mechanical messages clear the
  // unreviewed hold themselves, ambiguous ones raise the director's card.
  // triageIntake never throws and is a no-op when the project has not opted in.
  await triageIntake(db, task);
  return task;
}

// ------------------------------------------------------------------ poll
// One poll cycle across every project's configured spaces. Hard no-op when no
// project configures gchat_spaces (never resolves secrets, never hits network).
export async function pollGchatOnce(db: DB, deps: GchatDeps = {}): Promise<{ created: number; spaces: number }> {
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[hive] gchat: ${m}`, e ?? ""));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const notify = deps.notify ?? true;

  const projects = db.query("SELECT id, config FROM projects").all() as { id: string; config: string }[];
  const jobs: { projectId: string; space: string; planIntake: boolean }[] = [];
  // `gchat_spaces: "*"` means every space the authorized user is in; those
  // projects can only be expanded once we hold a token (spaces.list).
  const wildcards: { projectId: string; planIntake: boolean }[] = [];
  for (const p of projects) {
    let cfg: any = {};
    try {
      cfg = JSON.parse(p.config || "{}");
    } catch {
      cfg = {};
    }
    const planIntake = cfg.plan_intake === true;
    if (cfg.gchat_spaces === "*") {
      wildcards.push({ projectId: p.id, planIntake });
      continue;
    }
    const spaces: any[] = cfg.gchat_spaces ?? [];
    for (const s of spaces) if (s?.space) jobs.push({ projectId: p.id, space: s.space, planIntake });
  }
  if (jobs.length === 0 && wildcards.length === 0) return { created: 0, spaces: 0 }; // unconfigured: hard no-op

  const secrets = deps.secrets ?? (await resolveGchatSecrets(deps.exec ?? defaultExec));
  if (!secrets) {
    diagOnce("secrets", log, "spaces configured but connector secrets missing (run `hive gchat auth`)");
    return { created: 0, spaces: jobs.length };
  }
  clearDiag("secrets");

  const fetchImpl = deps.fetch ?? fetch;
  let token: string;
  try {
    token = await getAccessToken(secrets, fetchImpl, nowMs);
    clearDiag("token");
  } catch (e) {
    diagOnce("token", log, "access-token refresh failed", e);
    return { created: 0, spaces: jobs.length };
  }

  if (wildcards.length > 0) {
    try {
      const all = await listSpaces(token, fetchImpl);
      for (const w of wildcards) for (const space of all) jobs.push({ ...w, space });
      clearDiag("spaces.list");
    } catch (e) {
      diagOnce("spaces.list", log, "spaces.list failed (is the chat.spaces.readonly scope granted?)", e);
    }
  }

  let created = 0;
  for (const job of jobs) {
    try {
      const cursor = getCursor(db, "gchat", job.space);
      const msgs = await listMessages(job.space, cursor, token, fetchImpl);
      for (const msg of msgs) {
        const senderType = msg.sender?.type;
        const isSelf = secrets.self && msg.sender?.name === secrets.self;
        if (!isSelf && senderType !== "BOT") {
          const made = await createIntakeTask(db, job.projectId, job.space, msg, token, fetchImpl, notify, job.planIntake, deps.plannerExec);
          if (made) created++;
        }
        // Advance the cursor even for skipped messages so we never refetch them.
        if (msg.createTime) setCursor(db, "gchat", job.space, msg.createTime);
      }
      clearDiag(job.space);
    } catch (e) {
      diagOnce(job.space, log, `poll failed for ${job.space}`, e);
    }
  }
  return { created, spaces: jobs.length };
}

// Production starts one background loop from index.ts. Each start call owns its
// timer and in-flight guard; a slow cycle skips ticks instead of queueing them.
export function startGchatPoll(db: DB, deps: GchatDeps = {}): () => void {
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[hive] gchat: ${m}`, e ?? ""));
  const intervalMs = deps.intervalMs ?? Number(process.env.HIVE_GCHAT_POLL_MS || 60_000);
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      log("poll tick skipped: previous cycle still running");
      return;
    }
    running = true;
    pollGchatOnce(db, deps)
      .catch((e) => console.error("[hive] gchat poll crashed:", e))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ oauth (CLI)
// Build the consent URL for the interactive one-time auth (used by the CLI).
export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh_token every time
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Exchange an authorization code for tokens (returns the refresh_token).
export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch
): Promise<{ refresh_token?: string; access_token?: string }> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`code exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ refresh_token?: string; access_token?: string }>;
}
